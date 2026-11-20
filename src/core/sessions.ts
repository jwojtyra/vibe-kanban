import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitCacheDir, mcpConfig, promptTemplate, readonlySettings, renderPrompt, resolveResources, sessionSystemPrompt } from "./context.js";
import { commitAll, ensureGitResource, ensureTaskWorktree, hasChanges, prepareStepWorktree, stepRepo } from "./git.js";
import { cliPath, subdir } from "./paths.js";
import {
  blockReasons,
  effectiveDeps,
  effectiveResources,
  getItemByKey,
  getSettings,
  getTask,
  getTaskByKey,
  LEVEL,
  LEVEL_NAME,
  listItems,
  listQuestions,
  listSteps,
  listTaskRepos,
  runnableSteps,
  setItemFields,
  type Item,
  type Task,
  VkError,
} from "./repo.js";

/**
 * Specyfikacja sesji Claude Code: gdzie ją uruchomić i z jakimi argumentami.
 * Z tej samej specyfikacji korzysta CLI `vk` (uruchamia od razu) i serwer (generuje skrypt bash
 * do wklejenia w terminalu — bez instalowania czegokolwiek poza Claude Code, docker i curl).
 */
export interface SessionSpec {
  title: string;
  cwd: string;
  args: string[]; // argumenty dla `claude`
  clones: { url: string; dir: string }[]; // zasoby git do sklonowania na hoście przed startem
  messages: string[];
}

function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

/** Czy sesja Claude Code o danym ID istnieje już na dysku (wtedy --resume, inaczej --session-id). */
export function sessionExists(id: string): boolean {
  const dir = path.join(claudeConfigDir(), "projects");
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).some((p) => fs.existsSync(path.join(dir, p, `${id}.jsonl`)));
}

export function splitCommand(cmd: string): string[] {
  return cmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((s) => s.replace(/^["']|["']$/g, "")) ?? ["claude"];
}

export function claudeCommand(): string[] {
  return splitCommand(getSettings().claude_command || "claude");
}

/** Zmienne środowiskowe sesji: ładuj też CLAUDE.md z katalogów dodanych przez --add-dir. */
export const SESSION_ENV = { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" };

/** Zasoby git, których jeszcze nie ma w cache (sklonuje je skrypt na hoście). */
function pendingClones(task: Task) {
  return effectiveResources(task)
    .filter((r) => r.kind === "git")
    .map((r) => ({ url: r.location, dir: gitCacheDir(r.location) }))
    .filter((c) => !fs.existsSync(path.join(c.dir, ".git")));
}

function commonArgs(kind: "plan" | "impl" | "review", task: Task, step?: Item) {
  const res = resolveResources(task, "defer");
  const resDirs = res.map((r) => r.local_path).filter((p): p is string => !!p);
  // pozostałe repozytoria ticketu: przy planowaniu do wglądu, przy pracy nad Krokiem tylko do odczytu
  const repoDirs = listTaskRepos(task.id)
    .filter((r) => r.id !== step?.repo_id)
    .map((r) => r.path);
  const readonly = kind === "plan" ? resDirs : [...resDirs, ...repoDirs];
  const dirs = [...resDirs, ...repoDirs];
  return {
    res,
    clones: pendingClones(task),
    args: [
      "--append-system-prompt",
      sessionSystemPrompt(kind, task, res, step),
      "--mcp-config",
      mcpConfig(cliPath(), task.key, step?.key),
      "--settings",
      readonlySettings(readonly),
      ...(dirs.length ? ["--add-dir", ...dirs] : []),
    ],
  };
}

/** Stała, wznawialna sesja planowania ticketu (w stałym katalogu ~/.vk/plan/KLUCZ). */
export function planSpec(taskKey: string): SessionSpec {
  const task = getTaskByKey(taskKey);
  const { res, args, clones } = commonArgs("plan", task);
  const resume = sessionExists(task.plan_session_id);
  const head = resume
    ? ["--resume", task.plan_session_id]
    : [renderPrompt(promptTemplate(task, "plan"), task, undefined, res), "--session-id", task.plan_session_id];
  const repos = listTaskRepos(task.id);
  return {
    title: `vk plan ${task.key}`,
    cwd: subdir("plan", task.key),
    args: [...head, "-n", `vk plan ${task.key}`, ...args],
    clones,
    messages: [
      `${resume ? "Wznawiam" : "Rozpoczynam"} sesję planowania ${task.key}`,
      `Repozytoria: ${repos.map((r) => `${r.name} (${r.path})`).join(", ") || "(brak — sesja może je dołączyć: vk_attach_repo)"}`,
    ],
  };
}

/**
 * Sesja pracy nad Krokiem: stała sesja review w worktree Kroku (zna komentarze przez MCP),
 * albo z agent=true — wznowienie sesji subagenta, który wykonał Krok.
 */
export function openSpec(stepKey: string, opts: { agent?: boolean; fresh?: boolean }): SessionSpec {
  let sub = getItemByKey(stepKey);
  if (sub.level !== LEVEL.STEP) throw new VkError(`${sub.key} to ${LEVEL_NAME[sub.level]} — sesję pracy otwiera się dla Kroku`);
  const task = getTask(sub.task_id);
  let cwd: string;
  if (sub.status === "done" || ["draft", "todo"].includes(sub.status)) {
    cwd = ensureTaskWorktree(task, stepRepo(sub));
  } else {
    sub = prepareStepWorktree(sub.id);
    cwd = sub.worktree_path!;
  }
  const { res, args, clones } = commonArgs("review", task, sub);
  let head: string[];
  let msg: string;
  if (opts.agent) {
    if (!sub.agent_session_id || !sessionExists(sub.agent_session_id)) throw new VkError(`Krok ${sub.key} nie ma zapisanej sesji subagenta`);
    head = ["--resume", sub.agent_session_id];
    msg = `Wznawiam sesję subagenta ${sub.key}`;
  } else {
    let sid = sub.review_session_id;
    if (!sid || opts.fresh) {
      sid = randomUUID();
      sub = setItemFields(sub.id, { review_session_id: sid });
    }
    if (sessionExists(sid)) {
      head = ["--resume", sid];
      msg = `Wznawiam sesję review ${sub.key}`;
    } else {
      head = [renderPrompt(promptTemplate(task, "review"), task, sub, res), "--session-id", sid];
      msg = `Rozpoczynam sesję review ${sub.key}`;
    }
  }
  return { title: `vk ${sub.key}`, cwd, args: [...head, "-n", `vk ${sub.key}`, ...args], clones, messages: [msg, `Katalog: ${cwd}`] };
}

// ---------- realizacja Kroków (subagenci) ----------

export interface StepRun {
  step: Item;
  spec: SessionSpec;
  logPath: string;
}

/** Przygotowuje Krok do realizacji: worktree, status in_progress, argumenty `claude -p`. */
export function startStep(stepKey: string, opts: { force?: boolean } = {}): StepRun {
  let sub = getItemByKey(stepKey);
  if (sub.level !== LEVEL.STEP) throw new VkError(`${sub.key} to ${LEVEL_NAME[sub.level]} — wykonywane są tylko Kroki`);
  const task = getTask(sub.task_id);
  if (!["todo", "blocked", "in_progress"].includes(sub.status)) {
    throw new VkError(`Krok ${sub.key} ma status ${sub.status} — można uruchomić tylko todo/blocked`);
  }
  const items = listItems(task.id);
  const notReady = effectiveDeps(items, items.find((i) => i.id === sub.id)!).filter((s) => !["review", "done"].includes(s.status));
  if (notReady.length && !opts.force) {
    throw new VkError(`Zależności nie są gotowe: ${notReady.map((s) => `${s.key} (${s.status})`).join(", ")}. Użyj force, aby uruchomić mimo to.`);
  }
  const blocked = blockReasons(items, items.find((i) => i.id === sub.id)!, listQuestions(task.id));
  if (blocked.length && !opts.force) {
    throw new VkError(`Krok jest zablokowany: ${blocked.join("; ")}. Odpowiedz na pytania / usuń bloker w UI albo użyj force.`);
  }
  sub = prepareStepWorktree(sub.id);
  const settings = getSettings();
  const sessionId = randomUUID();
  const logPath = path.join(subdir("logs", task.key), `${sub.key}-${Date.now()}.jsonl`);
  sub = setItemFields(sub.id, { status: "in_progress", agent_session_id: sessionId, log_path: logPath, error: "" });

  const { res, args, clones } = commonArgs("impl", task, sub);
  const allowed = settings.exec_allowed_tools.split(/[\s,]+/).filter(Boolean);
  const claudeArgs = [
    "-p",
    renderPrompt(promptTemplate(task, "impl"), task, sub, res),
    "--session-id",
    sessionId,
    "-n",
    `vk ${sub.key} (agent)`,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    settings.exec_permission_mode || "acceptEdits",
    ...(settings.exec_model ? ["--model", settings.exec_model] : []),
    ...(allowed.length ? ["--allowedTools", ...allowed] : []),
    ...args,
  ];
  return { step: sub, logPath, spec: { title: `vk ${sub.key}`, cwd: sub.worktree_path!, args: claudeArgs, clones, messages: [] } };
}

/** Kończy realizację Kroku po wyjściu subagenta: commit i Review albo Blocked. Zwraca opis wyniku. */
export function finishStep(stepKey: string, code: number): { step: Item; message: string } {
  let sub = getItemByKey(stepKey);
  const resultText = lastResult(sub.log_path);
  if (sub.status !== "in_progress") return { step: sub, message: `→ ${sub.status}${resultText}` };
  if (code === 0) {
    commitAll(sub.worktree_path!, `${sub.key}: ${sub.title}`);
    sub = setItemFields(sub.id, { status: "review" });
    return { step: sub, message: `→ Review (zmiany zacommitowane automatycznie)${resultText}` };
  }
  const dirty = sub.worktree_path && hasChanges(sub.worktree_path);
  sub = setItemFields(sub.id, {
    status: "blocked",
    error: `Subagent zakończył się kodem ${code}${dirty ? " (są niezacommitowane zmiany w worktree)" : ""}. Log: ${sub.log_path}`,
  });
  return { step: sub, message: `→ Blocked (kod ${code})${resultText}` };
}

/** Krótka informacja z ostatniego zdarzenia "result" w logu subagenta. */
function lastResult(logPath: string | null): string {
  if (!logPath || !fs.existsSync(logPath)) return "";
  const lines = fs.readFileSync(logPath, "utf8").split("\n").filter((l) => l.includes('"type":"result"'));
  if (!lines.length) return "";
  try {
    const ev = JSON.parse(lines[lines.length - 1]);
    const cost = ev.total_cost_usd ? ` · $${Number(ev.total_cost_usd).toFixed(2)}` : "";
    const text = typeof ev.result === "string" ? ` · ${shortLine(ev.result, 200)}` : "";
    return `${cost}${text}`;
  } catch {
    return "";
  }
}

/** Następny Krok gotowy do realizacji (już przygotowany) albo null, gdy nic nie zostało. */
export function nextStep(taskKey: string, skip: string[] = []): StepRun | null {
  const task = getTaskByKey(taskKey);
  const next = runnableSteps(task.id).find((s) => !skip.includes(s.key));
  return next ? startStep(next.key) : null;
}

export function runSummary(taskKey: string): string[] {
  const task = getTaskByKey(taskKey);
  const subs = listSteps(task.id);
  const out = [
    `Koniec. Review: ${subs.filter((s) => s.status === "review").length}, blocked: ${subs.filter((s) => s.status === "blocked").length}, done: ${subs.filter((s) => s.status === "done").length}`,
  ];
  const left = subs.filter((s) => s.status === "todo" || s.status === "draft");
  if (left.length) {
    const items = listItems(task.id);
    out.push(
      `Czekają: ${left
        .map((s) => {
          const why = blockReasons(items, s, listQuestions(task.id));
          if (why.length) return `${s.key} ← zablokowany (${why.length}: pytania/blokery — sprawdź UI)`;
          return `${s.key} ← ${effectiveDeps(items, s).filter((d) => !["review", "done"].includes(d.status)).map((d) => d.key).join(", ") || "Draft"}`;
        })
        .join("; ")}`,
    );
  }
  return out;
}

// ---------- uruchamianie przez CLI `vk` (bez Dockera) ----------

function runClones(spec: SessionSpec) {
  for (const c of spec.clones) {
    try {
      ensureGitResource(c.url);
    } catch (e) {
      console.error(`[vk] Nie udało się sklonować ${c.url}: ${(e as Error).message}`);
    }
  }
}

function runInteractive(spec: SessionSpec): Promise<number> {
  runClones(spec);
  for (const m of spec.messages) console.error(`[vk] ${m}`);
  const [bin, ...pre] = claudeCommand();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...pre, ...spec.args], { cwd: spec.cwd, stdio: "inherit", env: { ...process.env, ...SESSION_ENV } });
    child.on("error", (e) => reject(new VkError(`Nie udało się uruchomić "${bin}": ${e.message}`)));
    child.on("exit", (code) => resolve(code ?? 0));
  });
}

export const planSession = (taskKey: string) => runInteractive(planSpec(taskKey));
export const openSession = (stepKey: string, opts: { agent?: boolean; fresh?: boolean }) => runInteractive(openSpec(stepKey, opts));

function shortLine(s: string, n = 160) {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

/** Wypisuje zwięzły podgląd strumienia stream-json subagenta. */
function printEvent(prefix: string, line: string) {
  let ev: any;
  try {
    ev = JSON.parse(line);
  } catch {
    return;
  }
  if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
    for (const c of ev.message.content) {
      if (c.type === "text" && c.text?.trim()) console.log(`${prefix} ${shortLine(c.text)}`);
      if (c.type === "tool_use") {
        const arg = c.input?.command ?? c.input?.file_path ?? c.input?.pattern ?? "";
        console.log(`${prefix} → ${c.name}${arg ? ` ${shortLine(String(arg), 100)}` : ""}`);
      }
    }
  }
}

/** vk exec KROK — subagent (claude -p) dla jednego Kroku. */
export async function execStep(stepKey: string, opts: { force?: boolean } = {}): Promise<Item> {
  const { step, spec, logPath } = startStep(stepKey, opts);
  runClones(spec);
  const prefix = `[${step.key}]`;
  console.log(`${prefix} start — worktree ${spec.cwd}`);
  const [bin, ...pre] = claudeCommand();
  const log = fs.createWriteStream(logPath);
  const code: number = await new Promise((resolve) => {
    const child = spawn(bin, [...pre, ...spec.args], { cwd: spec.cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...SESSION_ENV } });
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
      log.write(d);
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        printEvent(prefix, buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      log.write(JSON.stringify({ type: "stderr", text: d.toString() }) + "\n");
      process.stderr.write(`${prefix} ${d}`);
    });
    child.on("error", (e) => {
      log.write(JSON.stringify({ type: "stderr", text: e.message }) + "\n");
      resolve(127);
    });
    child.on("exit", (c) => resolve(c ?? 1));
  });
  await new Promise((r) => log.end(r));
  const { step: done, message } = finishStep(step.key, code);
  console.log(`${prefix} ${message}`);
  return done;
}

/** vk run TICKET — realizuje Kroki zgodnie z kolejnością planu i zależnościami. */
export async function runTask(taskKey: string, opts: { concurrency?: number } = {}): Promise<void> {
  const task = getTaskByKey(taskKey);
  if (listItems(task.id).some((s) => s.status === "draft")) {
    console.log(`[vk] Uwaga: część planu jest w Draft (niezaakceptowana) — te Kroki zostaną pominięte.`);
  }
  const limit = Math.max(1, opts.concurrency ?? (Number(getSettings().concurrency) || 1));
  const running = new Map<number, Promise<void>>();
  const failed = new Set<number>();
  for (;;) {
    const candidates = runnableSteps(task.id).filter((s) => !running.has(s.id) && !failed.has(s.id));
    while (running.size < limit && candidates.length) {
      const s = candidates.shift()!;
      const p = execStep(s.key)
        .then((r) => {
          if (r.status !== "review" && r.status !== "done") failed.add(s.id);
        })
        .catch((e) => {
          failed.add(s.id);
          setItemFields(s.id, { status: "blocked", error: String((e as Error).message) });
          console.error(`[${s.key}] błąd: ${(e as Error).message}`);
        })
        .finally(() => running.delete(s.id));
      running.set(s.id, p);
    }
    if (running.size === 0) break;
    await Promise.race(running.values());
  }
  for (const l of runSummary(taskKey)) console.log(`\n[vk] ${l}`);
}
