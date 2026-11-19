import { getSettings, VkError } from "../core/repo.js";
import { claudeCommand, SESSION_ENV, type SessionSpec, type StepRun } from "../core/sessions.js";

/**
 * Skrypty bash generowane przez serwer. Użytkownik wkleja w terminalu jedno polecenie, np.
 *   bash <(curl -fsS http://localhost:4777/x/plan/VK-1)
 * i skrypt uruchamia `claude` na hoście z gotowymi argumentami. Na hoście potrzebne są tylko:
 * bash, curl, git, Claude Code oraz docker (MCP działa w kontenerze przez `docker exec`).
 */

let publicBase = (process.env.VK_PUBLIC_URL || `http://localhost:${process.env.VK_PORT || 4777}`).replace(/\/+$/, "");

export function setPublicBase(port: number) {
  publicBase = (process.env.VK_PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, "");
}

/** Bezpieczne cytowanie dla bash (pojedyncze apostrofy). */
export function q(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

const arr = (xs: string[]) => `( ${xs.map(q).join(" ")} )`;

/** Polecenie do skopiowania z UI. Gdy w Ustawieniach podano polecenie CLI — styl `vk plan KLUCZ`. */
export function copyCommand(kind: "plan" | "run" | "open" | "agent" | "exec", key: string): string {
  const cli = getSettings().cli_command.trim();
  if (cli) {
    const sub = { plan: `plan ${key}`, run: `run ${key}`, open: `open ${key}`, agent: `open ${key} --agent`, exec: `exec ${key}` }[kind];
    return `${cli} ${sub}`;
  }
  const url = {
    plan: `/x/plan/${key}`,
    run: `/x/run/${key}`,
    open: `/x/open/${key}`,
    agent: `/x/open/${key}?agent=1`,
    exec: `/x/exec/${key}`,
  }[kind];
  return `bash <(curl -fsS ${q(publicBase + url)})`;
}

function preamble(title: string): string[] {
  const lines = [
    "#!/usr/bin/env bash",
    `# vibe-kanban: ${title.replace(/\n/g, " ")}`,
    "set -u",
    `VK_CLAUDE=${arr(claudeCommand())}`,
    `command -v "\${VK_CLAUDE[0]}" >/dev/null 2>&1 || { echo "vk: nie znaleziono polecenia \${VK_CLAUDE[0]} (Claude Code) — zainstaluj je lub zmień w Ustawieniach" >&2; exit 1; }`,
  ];
  const container = process.env.VK_CONTAINER;
  if (container) {
    lines.push(
      `docker exec ${q(container)} true >/dev/null 2>&1 || echo "vk: uwaga — kontener ${container} nie odpowiada na docker exec; narzędzia MCP vibe-kanban nie będą dostępne w sesji" >&2`,
    );
  }
  for (const [k, v] of Object.entries(SESSION_ENV)) lines.push(`export ${k}=${q(v)}`);
  return lines;
}

function cloneLines(spec: SessionSpec): string[] {
  return spec.clones.map((c) => `[ -d ${q(c.dir + "/.git")} ] || git clone --depth 1 ${q(c.url)} ${q(c.dir)} >&2 || echo "vk: nie udało się sklonować ${c.url.replace(/["$`\\]/g, "")}" >&2`);
}

/** Skrypt uruchamiający interaktywną sesję (planowanie / praca nad Krokiem). */
export function interactiveScript(spec: SessionSpec): string {
  return [
    ...preamble(spec.title),
    ...cloneLines(spec),
    ...spec.messages.map((m) => `echo ${q(`[vk] ${m}`)} >&2`),
    `cd ${q(spec.cwd)} || exit 1`,
    `exec "\${VK_CLAUDE[@]}" ${spec.args.map(q).join(" ")}`,
    "",
  ].join("\n");
}

/** Fragment (do `eval`) opisujący Krok do wykonania albo VK_DONE=1. */
export function stepFragment(run: StepRun | null): string {
  if (!run) return "VK_DONE=1\n";
  return [
    "VK_DONE=0",
    ...cloneLines(run.spec),
    `VK_STEP=${q(run.step.key)}`,
    `VK_TITLE=${q(run.step.title)}`,
    `VK_CWD=${q(run.spec.cwd)}`,
    `VK_LOG=${q(run.logPath)}`,
    `VK_ARGS=${arr(run.spec.args)}`,
    "",
  ].join("\n");
}

export function errorFragment(e: unknown): string {
  const msg = e instanceof VkError || e instanceof Error ? e.message : String(e);
  return `echo ${q(`vk: ${msg}`)} >&2\nVK_DONE=1\nVK_ERROR=1\n`;
}

export function errorScript(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return `#!/usr/bin/env bash\necho ${q(`vk: ${msg}`)} >&2\nexit 1\n`;
}

/** Wspólna część: wykonanie jednego Kroku opisanego przez fragment i zgłoszenie wyniku. */
function runOneStepLines(base: string): string[] {
  return [
    `  echo "[$VK_STEP] start: $VK_TITLE"`,
    `  echo "[$VK_STEP] worktree: $VK_CWD — podgląd na żywo w UI (Log subagenta)"`,
    `  ( cd "$VK_CWD" && "\${VK_CLAUDE[@]}" "\${VK_ARGS[@]}" >"$VK_LOG" 2>"$VK_LOG.stderr" </dev/null )`,
    `  code=$?`,
    `  echo "[$VK_STEP] $(curl -sS -X POST "${base}/x/finish/$VK_STEP?code=$code")"`,
  ];
}

/** Skrypt realizacji ticketu: pętla po kolejnych gotowych Krokach. */
export function runScript(taskKey: string): string {
  const base = publicBase;
  return [
    ...preamble(`run ${taskKey}`),
    `echo "[vk] Realizacja ${taskKey} — Kroki wg kolejności planu i zależności (Ctrl+C przerywa)"`,
    "while :; do",
    `  VK_FRAG=$(curl -sS -X POST ${q(`${base}/x/next/${taskKey}`)}) || { echo "vk: serwer vibe-kanban niedostępny (${base})" >&2; exit 1; }`,
    `  VK_DONE=1; eval "$VK_FRAG"`,
    `  [ "$VK_DONE" = 1 ] && break`,
    ...runOneStepLines(base),
    "done",
    `curl -sS ${q(`${base}/x/summary/${taskKey}`)}`,
    "",
  ].join("\n");
}

/** Skrypt wykonania jednego Kroku. */
export function execScript(stepKey: string, force: boolean): string {
  const base = publicBase;
  return [
    ...preamble(`exec ${stepKey}`),
    `VK_FRAG=$(curl -sS -X POST ${q(`${base}/x/start/${stepKey}${force ? "?force=1" : ""}`)}) || { echo "vk: serwer vibe-kanban niedostępny (${base})" >&2; exit 1; }`,
    `VK_DONE=1; eval "$VK_FRAG"`,
    `[ "$VK_DONE" = 1 ] && exit 1`,
    "{",
    ...runOneStepLines(base),
    "}",
    "",
  ].join("\n");
}
