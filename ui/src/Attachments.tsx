import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { api, type Attachment } from "./api";

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function upload(taskId: number, file: File, note: string): Promise<Attachment> {
  const q = new URLSearchParams({ name: file.name, ...(note ? { note } : {}) });
  const r = await fetch(`/api/tasks/${taskId}/attachments?${q}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${r.status}`);
  return data as Attachment;
}

/** Nazwa dla wklejonego zrzutu ekranu (schowek nie podaje sensownej nazwy). */
function pastedName(f: File, i: number): string {
  const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg");
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `zrzut-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${i ? `-${i + 1}` : ""}.${ext}`;
}

/**
 * Załączniki ticketu: przeciągnij pliki, wybierz z dysku albo wklej zrzut ekranu (Ctrl+V).
 * ZIP jest rozpakowywany na serwerze; wszystko trafia do sesji Claude jako pliki tylko do odczytu.
 */
export function AttachmentsEditor({
  taskId,
  attachments,
  onChanged,
  onError,
}: {
  taskId: number;
  attachments: Attachment[];
  onChanged: () => void;
  onError: (m: string) => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [openFiles, setOpenFiles] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const send = async (files: File[]) => {
    if (!files.length) return;
    try {
      for (const f of files) {
        setBusy(`Wysyłam ${f.name} (${formatSize(f.size)})…`);
        await upload(taskId, f, note.trim());
      }
      setNote("");
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
      onChanged();
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    send(Array.from(e.dataTransfer.files));
  };

  useEffect(() => {
    // wklejanie zrzutów ekranu w dowolnym miejscu okna
    const f = (e: Event) => {
      const ce = e as unknown as ClipboardEvent;
      const files = Array.from(ce.clipboardData?.files ?? []);
      if (!files.length) return;
      e.preventDefault();
      send(files.map((file, i) => (file.name && file.name !== "image.png" ? file : new File([file], pastedName(file, i), { type: file.type }))));
    };
    window.addEventListener("paste", f);
    return () => window.removeEventListener("paste", f);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, note]);

  const editNote = (a: Attachment) => {
    const v = prompt(`Opis dla agenta: ${a.name}`, a.note);
    if (v === null) return;
    api.put(`/api/attachments/${a.id}`, { note: v }).then(onChanged).catch((e) => onError(e.message));
  };

  return (
    <div className="stack">
      <div
        className={`dropzone ${over ? "dropzone-over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        onClick={() => input.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && input.current?.click()}
      >
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            send(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        {busy ?? (
          <>
            <b>Przeciągnij pliki tutaj</b> albo kliknij, aby wybrać · zrzut ekranu wklej <span className="kbd">Ctrl+V</span>
            <div className="muted small">ZIP zostanie rozpakowany. Obrazy agent obejrzy narzędziem Read. Limit 200 MB na plik.</div>
          </>
        )}
      </div>
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Opis dla agenta do kolejnych plików (opcjonalnie), np. „makieta ekranu listy zamówień”" />

      {attachments.length === 0 && <div className="muted small">Brak załączników.</div>}
      <div className="attachments">
        {attachments.map((a) => (
          <div key={a.id} className="attachment-row">
            {a.kind === "image" ? (
              <a href={`/api/attachments/${a.id}/file`} target="_blank" rel="noreferrer" className="attachment-thumb">
                <img src={`/api/attachments/${a.id}/file`} alt={a.name} loading="lazy" />
              </a>
            ) : (
              <div className="attachment-thumb attachment-icon">{a.kind === "archive" ? "ZIP" : (a.name.split(".").pop() ?? "").slice(0, 4).toUpperCase() || "PLIK"}</div>
            )}
            <div className="grow minw0">
              <div className="attachment-name">
                <b>{a.name}</b> <span className="muted small">{formatSize(a.size)}</span>
              </div>
              {a.note ? <div className="small">{a.note}</div> : <div className="muted small">bez opisu</div>}
              {a.extract_info && (
                <div className={`small ${a.extracted ? "muted" : "warn-text"}`}>
                  {a.extracted ? "Rozpakowane: " : ""}
                  {a.extract_info}
                  {a.files && a.files.length > 0 && (
                    <button className="btn btn-ghost btn-tiny" onClick={() => setOpenFiles(openFiles === a.id ? null : a.id)}>
                      {openFiles === a.id ? "ukryj" : "pokaż pliki"}
                    </button>
                  )}
                </div>
              )}
              {openFiles === a.id && a.files && (
                <ul className="attachment-files mono small">
                  {a.files.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                  {a.files.length >= 200 && <li className="muted">…</li>}
                </ul>
              )}
              <div className="muted small mono attachment-path" title="Ścieżka widoczna dla sesji Claude">
                {a.extracted_path ?? a.local_path}
              </div>
            </div>
            <div className="attachment-actions">
              <button className="btn btn-ghost btn-small" onClick={() => editNote(a)}>
                Opis
              </button>
              <a className="btn btn-ghost btn-small" href={`/api/attachments/${a.id}/file?download=1`}>
                Pobierz
              </a>
              <button
                className="btn btn-ghost btn-small btn-danger"
                onClick={() => confirm(`Usunąć załącznik ${a.name}?`) && api.del(`/api/attachments/${a.id}`).then(onChanged).catch((e) => onError(e.message))}
              >
                Usuń
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
