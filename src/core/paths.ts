import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/** Katalog danych narzędzia (baza, worktree, cache zasobów, logi). */
export function vkHome(): string {
  const dir = process.env.VK_HOME || path.join(os.homedir(), ".vk");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function subdir(...parts: string[]): string {
  const dir = path.join(vkHome(), ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Ścieżka do skompilowanego cli.js (używana w konfiguracji MCP dla sesji). */
export function cliPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
}

export function uiDistPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ui");
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "x";
}
