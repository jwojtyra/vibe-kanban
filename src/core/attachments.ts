import fs from "node:fs";
import path from "node:path";
import { all, get, run } from "./db.js";
import { subdir, vkHome } from "./paths.js";
import { getTask, type Task, VkError } from "./repo.js";
import { extractZip } from "./zip.js";

/**
 * Załączniki ticketu (np. ZIP ze specyfikacją, zrzuty ekranu, makiety, PDF).
 * Pliki leżą w ~/.vk/attachments/<KLUCZ>/ — ten katalog jest wspólny dla kontenera i sesji Claude
 * na hoście, więc sesje czytają je bezpośrednio (tylko do odczytu). ZIP jest od razu rozpakowywany
 * do katalogu obok (spec.zip → spec/), żeby agent mógł przeglądać jego zawartość.
 */

export const MAX_ATTACHMENT_BYTES = 200 * 1024 * 1024;

export interface Attachment {
  id: number;
  task_id: number;
  name: string; // nazwa pliku w katalogu załączników
  size: number;
  mime: string;
  note: string;
  extracted: string | null; // katalog z rozpakowanym ZIP-em (względny)
  extract_info: string; // liczba plików / pominięte wpisy / błąd rozpakowania
  created_at: string;
}

export interface AttachmentView extends Attachment {
  kind: "image" | "archive" | "file";
  local_path: string;
  extracted_path: string | null;
  files?: string[]; // zawartość rozpakowanego archiwum (skrócona)
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".html": "text/html",
  ".xml": "application/xml",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
};

export function mimeOf(name: string): string {
  return MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream";
}

/** Obrazy, które Claude Code potrafi obejrzeć narzędziem Read (i które UI pokazuje jako miniatury). */
export function isImage(name: string): boolean {
  return [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(path.extname(name).toLowerCase());
}

const isZip = (name: string, buf: Buffer) => path.extname(name).toLowerCase() === ".zip" || (buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50);

export function attachmentsDir(task: Task): string {
  return subdir("attachments", task.key);
}

/** Katalog załączników, jeśli istnieje (bez tworzenia) — do kontekstu sesji. */
export function existingAttachmentsDir(task: Task): string | null {
  const dir = path.join(vkHome(), "attachments", task.key);
  return fs.existsSync(dir) && listAttachments(task.id).length ? dir : null;
}

/** Bezpieczna nazwa pliku: bez katalogów, znaków sterujących i kropek na początku. */
export function safeFileName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "").normalize("NFC");
  const clean = base
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
    .replace(/^[.\s]+/, "")
    .trim()
    .slice(-150);
  return clean || "plik";
}

/** Nazwa nieużywana w katalogu (ani jako plik, ani jako katalog rozpakowanego ZIP-a). */
function uniqueName(dir: string, name: string, taken: Set<string>): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length) || name;
  let candidate = name;
  for (let i = 2; taken.has(candidate) || fs.existsSync(path.join(dir, candidate)); i++) candidate = `${stem} (${i})${ext}`;
  return candidate;
}

function toView(a: Attachment, task: Task): AttachmentView {
  const dir = path.join(vkHome(), "attachments", task.key);
  const extractedPath = a.extracted ? path.join(dir, a.extracted) : null;
  let files: string[] | undefined;
  if (extractedPath && fs.existsSync(extractedPath)) {
    files = listFiles(extractedPath, 200);
  }
  return {
    ...a,
    kind: isImage(a.name) ? "image" : a.extracted !== null || a.mime === "application/zip" ? "archive" : "file",
    local_path: path.join(dir, a.name),
    extracted_path: extractedPath,
    files,
  };
}

function listFiles(root: string, max: number): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
      if (out.length >= max) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else out.push(r);
    }
  };
  walk("");
  return out;
}

export function listAttachments(taskId: number): Attachment[] {
  return all<Attachment>("SELECT * FROM attachments WHERE task_id = ? ORDER BY id", taskId);
}

export function listAttachmentViews(taskId: number): AttachmentView[] {
  const task = getTask(taskId);
  return listAttachments(taskId).map((a) => toView(a, task));
}

export function getAttachment(id: number): Attachment {
  const a = get<Attachment>("SELECT * FROM attachments WHERE id = ?", id);
  if (!a) throw new VkError(`Brak załącznika ${id}`, 404);
  return a;
}

export function attachmentView(id: number): AttachmentView {
  const a = getAttachment(id);
  return toView(a, getTask(a.task_id));
}

export function attachmentFilePath(a: Attachment): string {
  return path.join(attachmentsDir(getTask(a.task_id)), a.name);
}

export function addAttachment(taskId: number, originalName: string, data: Buffer, note = ""): AttachmentView {
  const task = getTask(taskId);
  if (!data.length) throw new VkError("Pusty plik");
  if (data.length > MAX_ATTACHMENT_BYTES) throw new VkError(`Plik jest za duży (limit ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB)`);
  const dir = attachmentsDir(task);
  const taken = new Set<string>();
  for (const a of listAttachments(taskId)) {
    taken.add(a.name);
    if (a.extracted) taken.add(a.extracted);
  }
  const name = uniqueName(dir, safeFileName(originalName), taken);
  taken.add(name);
  fs.writeFileSync(path.join(dir, name), data);

  let extracted: string | null = null;
  let info = "";
  if (isZip(name, data)) {
    const ext = path.extname(name);
    const dirName = uniqueName(dir, (ext ? name.slice(0, -ext.length) : name) || "archiwum", taken);
    try {
      const r = extractZip(data, path.join(dir, dirName));
      extracted = dirName;
      info = `${r.files.length} plik(i/ów)${r.skipped.length ? `; pominięte: ${r.skipped.slice(0, 10).join(", ")}${r.skipped.length > 10 ? "…" : ""}` : ""}`;
    } catch (e) {
      fs.rmSync(path.join(dir, dirName), { recursive: true, force: true });
      info = `Nie udało się rozpakować: ${(e as Error).message}`;
    }
  }
  const r = run(
    "INSERT INTO attachments(task_id, name, size, mime, note, extracted, extract_info) VALUES(?, ?, ?, ?, ?, ?, ?)",
    taskId,
    name,
    data.length,
    mimeOf(name),
    note.trim(),
    extracted,
    info,
  );
  return attachmentView(Number(r.lastInsertRowid));
}

export function updateAttachment(id: number, data: { note?: string }): AttachmentView {
  getAttachment(id);
  if (data.note !== undefined) run("UPDATE attachments SET note = ? WHERE id = ?", String(data.note).trim(), id);
  return attachmentView(id);
}

export function deleteAttachment(id: number) {
  const a = getAttachment(id);
  const dir = attachmentsDir(getTask(a.task_id));
  fs.rmSync(path.join(dir, a.name), { force: true });
  if (a.extracted) fs.rmSync(path.join(dir, a.extracted), { recursive: true, force: true });
  run("DELETE FROM attachments WHERE id = ?", id);
}

/** Usuwa katalog załączników ticketu (przy usuwaniu ticketu). */
export function removeTaskAttachments(task: Task) {
  fs.rmSync(path.join(vkHome(), "attachments", task.key), { recursive: true, force: true });
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Lista załączników do promptu / system promptu. */
export function attachmentsText(task: Task): string {
  const list = listAttachmentViews(task.id);
  if (!list.length) return "(brak)";
  return list
    .map((a) => {
      const extra =
        a.kind === "image"
          ? " — obraz: obejrzyj go narzędziem Read"
          : a.extracted_path
            ? ` — rozpakowane do ${a.extracted_path}/ (${a.extract_info})`
            : a.extract_info
              ? ` — ${a.extract_info}`
              : "";
      return `- ${a.local_path} (${formatSize(a.size)})${extra}${a.note ? `\n  Opis: ${a.note}` : ""}`;
    })
    .join("\n");
}
