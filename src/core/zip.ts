import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { VkError } from "./repo.js";

/**
 * Minimalny czytnik ZIP (bez zależności): metody store (0) i deflate (8), bez szyfrowania i ZIP64.
 * Chroni przed zip-slip (ścieżki poza katalogiem docelowym), dowiązaniami symbolicznymi
 * i zip-bombami (limity liczby wpisów i łącznego rozmiaru po rozpakowaniu).
 */

export interface ZipLimits {
  maxEntries: number;
  maxTotalBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = { maxEntries: 20_000, maxTotalBytes: 1024 * 1024 * 1024 };

export interface ZipResult {
  files: string[]; // ścieżki względne rozpakowanych plików
  skipped: string[]; // pominięte wpisy z powodem
}

const EOCD = 0x06054b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;

/** Bezpieczna ścieżka względna wpisu albo null, gdy wpis trzeba pominąć. */
export function safeEntryPath(name: string): string | null {
  const n = name.replace(/\\/g, "/");
  if (n.startsWith("/") || /^[a-zA-Z]:/.test(n)) return null;
  const parts = n.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === ".." || p.includes("\0"))) return null;
  return parts.length ? parts.join("/") : null;
}

/** Metadane dodawane przez macOS (Finder) — pomijane po cichu. */
function isJunk(name: string): boolean {
  const parts = name.replace(/\\/g, "/").split("/");
  return parts[0] === "__MACOSX" || parts[parts.length - 1] === ".DS_Store";
}

export function extractZip(buf: Buffer, dest: string, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipResult {
  // koniec katalogu centralnego: ostatnie 22 bajty + komentarz (≤ 65535)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new VkError("To nie jest poprawny plik ZIP");
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new VkError("ZIP64 nie jest obsługiwany — spakuj archiwum zwykłym ZIP");
  if (count > limits.maxEntries) throw new VkError(`Archiwum ma za dużo plików (${count} > ${limits.maxEntries})`);

  const root = path.resolve(dest);
  fs.mkdirSync(root, { recursive: true });
  const out: ZipResult = { files: [], skipped: [] };
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN) throw new VkError("Uszkodzony katalog centralny ZIP");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const extAttr = buf.readUInt32LE(p + 38);
    const local = buf.readUInt32LE(p + 42);
    const rawName = buf.subarray(p + 46, p + 46 + nameLen);
    const name = rawName.toString(flags & 0x800 ? "utf8" : "latin1");
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue; // katalog
    if (isJunk(name)) continue; // metadane macOS
    const rel = safeEntryPath(name);
    if (!rel) {
      out.skipped.push(`${name} (niedozwolona ścieżka)`);
      continue;
    }
    if (((extAttr >>> 16) & 0o170000) === 0o120000) {
      out.skipped.push(`${rel} (dowiązanie symboliczne)`);
      continue;
    }
    if (flags & 0x1) {
      out.skipped.push(`${rel} (zaszyfrowany)`);
      continue;
    }
    if (compSize === 0xffffffff || size === 0xffffffff || local === 0xffffffff) throw new VkError("ZIP64 nie jest obsługiwany");
    total += size;
    if (total > limits.maxTotalBytes) throw new VkError(`Archiwum po rozpakowaniu przekracza ${Math.round(limits.maxTotalBytes / 1024 / 1024)} MB`);

    if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOC) throw new VkError(`Uszkodzony wpis ZIP: ${rel}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + compSize);
    let content: Buffer;
    if (method === 0) content = Buffer.from(data);
    else if (method === 8) content = zlib.inflateRawSync(data, { maxOutputLength: Math.max(size, 1) });
    else {
      out.skipped.push(`${rel} (nieobsługiwana metoda kompresji ${method})`);
      continue;
    }
    if (content.length !== size) throw new VkError(`Uszkodzony wpis ZIP (rozmiar): ${rel}`);

    const target = path.resolve(root, rel);
    if (!target.startsWith(root + path.sep)) {
      out.skipped.push(`${rel} (poza katalogiem docelowym)`);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    out.files.push(rel);
  }
  return out;
}
