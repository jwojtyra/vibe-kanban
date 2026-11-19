import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mcpConfig, promptTemplate, readonlySettings, renderPrompt, resolveResources, sessionSystemPrompt } from "./context.js";
import { commitAll, ensureTaskWorktree, hasChanges, prepareStepWorktree, stepRepo } from "./git.js";
import { cliPath, subdir } from "./paths.js";
import {
  effectiveDeps,
  getItem,
  getItemByKey,
  getSettings,
  getTask,
  getTaskByKey,
  LEVEL,
  LEVEL_NAME,
  listItems,
  listSteps,
  listTaskRepos,
  runnableSteps,
  setItemFields,
  type Item,
  type Task,
  VkError,
} from "./repo.js";

function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

/** Czy sesja Claude Code o danym ID istnieje już na dysku (wtedy --resume, inaczej --session-id). */
export function sessionExists(id: string): boolean {
  const dir = path.join(claudeConfigDir(), "projects");
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).some((p) => fs.existsSync(path.join(dir, p, `${id}.jsonl`)));
}

function splitCommand(cmd: string): string[] {
  return cmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((s) => s.replace(/^["']|["']$/g, "")) ?? ["claude"];
}

function runInteractive(args: string[], cwd: string): Promise<number> {
  const [bin, ...pre] = splitCommand(getSettings().claude_command || "claude");
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...pre, ...args], { cwd, stdio: "inherit", env: claudeEnv() });
    child.on("error", (e) => reject(new VkError(`Nie udało się uruchomić "${bin}": ${e.message}`)));
    child.on("exit", (code) => resolve(code ?? 0));
  });
}

/** Ładuj też CLAUDE.md z katalogów dodanych przez --add-dir (repozytoria ticketu). */
function claudeEnv() {
  return { ...process.env, CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" };
}

function commonArgs(kind: "plan" | "impl" | "review", task: Task, step?: Item) {
  const res = resolveResources(task, true);
  const resDirs = res.map((r) => r.local_path).filter((p): p is string => !!p);
  // pozostałe repozytoria ticketu: przy planowaniu do wglądu, przy pracy nad Krokiem tylko do odczytu
  const repoDirs = listTaskRepos(task.id)
    .filter((r) => r.id !== step?.repo_id)
    .map((r) => r.path);
  const readonly = kind === "plan" ? resDirs : [...resDirs, ...repoDirs];
  const dirs = [...resDirs, ...repoDirs];
  return {
    res,
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

/** Stały katalog roboczy sesji planowania (niezależny od liczby repozytoriów — sesja da się zawsze wznowić). */
function planDir(task: Task) {
  return subdir("plan", task.key);
}

/** vk plan KEY — stała, wznawialna sesja planowania ticketu. */
export async function planSession(taskKey: string): Promise<number> {
  const task = getTaskByKey(taskKey);
  if (listTaskRepos(task.id).length === 0) console.error("[vk] Uwaga: ticket nie ma repozytoriów — sesja może je dołączyć (vk_attach_repo).");
  const cwd = planDir(task);
  const { res, args } = commonArgs("plan", task);
  const resume = sessionExists(task.plan_session_id);
  const head = resume
    ? ["--resume", task.plan_session_id]
    : [renderPrompt(promptTemplate(task, "plan"), task, undefined, res), "--session-id", task.plan_session_id];
  console.error(`[vk] ${resume ? "Wznawiam" : "Rozpoczynam"} sesję planowania ${task.key} (${task.plan_session_id})`);
  console.error(`[vk] Repozytoria: ${listTaskRepos(task.id).map((r) => `${r.name} (${r.path})`).join(", ") || "(brak)"}`);
  return runInteractive([...head, "-n", `vk plan ${task.key}`, ...args], cwd);
}

/**
 * vk open KROK — stała sesja review w worktree Kroku (zna komentarze przez MCP).
 * vk open KROK --agent — wznawia sesję subagenta, który wykonał Krok.
 */
export async function openSession(stepKey: string, opts: { agent?: boolean; fresh?: boolean }): Promise<number> {
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
  const kind = "review" as const;
  const { res, args } = commonArgs(kind, task, sub);
  let head: string[];
  if (opts.agent) {
    if (!sub.agent_session_id || !sessionExists(sub.agent_session_id)) {
      throw new VkError(`Krok ${sub.key} nie ma zapisanej sesji subagenta`);
    }
    head = ["--resume", sub.agent_session_id];
    console.error(`[vk] Wznawiam sesję subagenta ${sub.agent_session_id} (${sub.key}) w ${cwd}`);
  } else {
    let sid = sub.review_session_id;
    if (!sid || opts.fresh) {
      sid = randomUUID();
      sub = setItemFields(sub.id, { review_session_id: sid });
    }
    if (sessionExists(sid)) {
      head = ["--resume", sid];
      console.error(`[vk] Wznawiam sesję review ${sub.key} (${sid}) w ${cwd}`);
    } else {
      head = [renderPrompt(promptTemplate(task, "review"), task, sub, res), "--session-id", sid];
      console.error(`[vk] Rozpoczynam sesję review ${sub.key} (${sid}) w ${cwd}`);
    }
  }
  return runInteractive([...head, "-n", `vk ${sub.key}`, ...args], cwd);
}

// ---------- realizacja (subagenci) ----------

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
  } else if (ev.type === "result") {
    console.log(`${prefix} ■ ${ev.subtype ?? "koniec"}${ev.total_cost_usd ? ` ($${Number(ev.total_cost_usd).toFixed(2)})` : ""}`);
  }
}

/** vk exec KROK — uruchamia subagenta (claude -p) dla jednego Kroku. */
export async function execStep(stepKey: string, opts: { force?: boolean } = {}): Promise<Item> {
  let sub = getItemByKey(stepKey);
  if (sub.level !== LEVEL.STEP) throw new VkError(`${sub.key} to ${LEVEL_NAME[sub.level]} — wykonywane są tylko Kroki (vk run wykona cały ticket)`);
  const task = getTask(sub.task_id);
  if (!["todo", "blocked", "in_progress"].includes(sub.status)) {
    throw new VkError(`Krok ${sub.key} ma status ${sub.status} — można uruchomić tylko todo/blocked`);
  }
  const items = listItems(task.id);
  const notReady = effectiveDeps(items, items.find((i) => i.id === sub.id)!).filter((s) => !["review", "done"].includes(s.status));
  if (notReady.length && !opts.force) {
    throw new VkError(`Zależności nie są gotowe: ${notReady.map((s) => `${s.key} (${s.status})`).join(", ")}. Użyj --force, aby uruchomić mimo to.`);
  }
  sub = prepareStepWorktree(sub.id);
  const settings = getSettings();
  const sessionId = randomUUID();
  const logPath = path.join(subdir("logs", task.key), `${sub.key}-${Date.now()}.jsonl`);
  sub = setItemFields(sub.id, { status: "in_progress", agent_session_id: sessionId, log_path: logPath, error: "" });

  const { res, args } = commonArgs("impl", task, sub);
  const prompt = renderPrompt(promptTemplate(task, "impl"), task, sub, res);
  const [bin, ...pre] = splitCommand(settings.claude_command || "claude");
  const allowed = settings.exec_allowed_tools.split(/[\s,]+/).filter(Boolean);
  const fullArgs = [
    ...pre,
    "-p",
    prompt,
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
  const prefix = `[${sub.key}]`;
  console.log(`${prefix} start — worktree ${sub.worktree_path}, sesja ${sessionId}`);
  const log = fs.createWriteStream(logPath);
  const code: number = await new Promise((resolve) => {
    const child = spawn(bin, fullArgs, { cwd: sub.worktree_path!, stdio: ["ignore", "pipe", "pipe"], env: claudeEnv() });
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
  log.end();

  sub = getItem(sub.id);
  if (sub.status === "in_progress") {
    if (code === 0) {
      commitAll(sub.worktree_path!, `${sub.key}: ${sub.title}`);
      sub = setItemFields(sub.id, { status: "review" });
      console.log(`${prefix} → Review (agent zakończył bez vk_submit_for_review — zmiany zacommitowane automatycznie)`);
    } else {
      const dirty = sub.worktree_path && hasChanges(sub.worktree_path);
      sub = setItemFields(sub.id, {
        status: "blocked",
        error: `Subagent zakończył się kodem ${code}${dirty ? " (są niezacommitowane zmiany w worktree)" : ""}. Log: ${logPath}`,
      });
      console.log(`${prefix} → Blocked (kod ${code})`);
    }
  } else {
    console.log(`${prefix} → ${sub.status}`);
  }
  return sub;
}

/**
 * vk run KEY — realizuje Kroki zgodnie z kolejnością planu i zależnościami (także Funkcji i Etapów).
 * Krok rusza, gdy wszystkie jego efektywne zależności są w Review lub Done.
 */
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

  const subs = listSteps(task.id);
  const left = subs.filter((s) => s.status === "todo");
  console.log(`\n[vk] Koniec. Review: ${subs.filter((s) => s.status === "review").length}, ` +
    `blocked: ${subs.filter((s) => s.status === "blocked").length}, done: ${subs.filter((s) => s.status === "done").length}`);
  if (left.length) {
    const items = listItems(task.id);
    console.log(
      `[vk] Czekają (zależności nie są gotowe lub plan niezaakceptowany): ${left
        .map((s) => `${s.key} ← ${effectiveDeps(items, s).filter((d) => !["review", "done"].includes(d.status)).map((d) => d.key).join(", ") || "Draft"}`)
        .join("; ")}`,
    );
  }
}

