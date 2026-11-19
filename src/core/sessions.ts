import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addDirArgs, mcpConfig, promptTemplate, readonlySettings, renderPrompt, resolveResources, sessionSystemPrompt } from "./context.js";
import { commitAll, ensureTaskWorktree, hasChanges, prepareSubtaskWorktree, subtaskRepo, taskWorktreePath } from "./git.js";
import { cliPath, subdir } from "./paths.js";
import {
  getSettings,
  listRepos,
  getSubtask,
  getSubtaskByKey,
  getTask,
  getTaskByKey,
  listSubtasks,
  runnableSubtasks,
  setSubtaskFields,
  type Subtask,
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

/** Ładuj też CLAUDE.md z katalogów dodanych przez --add-dir (repozytoria projektu). */
function claudeEnv() {
  return { ...process.env, CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" };
}

function commonArgs(kind: "plan" | "impl" | "review", task: Task, sub?: Subtask) {
  const res = resolveResources(task, true);
  // pozostałe repozytoria projektu: przy planowaniu do wglądu, przy pracy nad podzadaniem tylko do odczytu
  const repos = listRepos(task.project_id).filter((r) => r.id !== sub?.repo_id);
  const repoDirs = repos.map((r) => r.path);
  const readonly = kind === "plan" ? res : [...res, ...repos.map((r) => ({ name: r.name, scope: "repo", kind: "path", location: r.path, local_path: r.path, note: "" }))];
  return {
    res,
    args: [
      "--append-system-prompt",
      sessionSystemPrompt(kind, task, res, sub),
      "--mcp-config",
      mcpConfig(cliPath(), task.key, sub?.key),
      "--settings",
      readonlySettings(readonly),
      ...addDirArgs([...res, ...repoDirs.map((p) => ({ name: "", scope: "repo", kind: "path", location: p, local_path: p, note: "" }))]),
    ],
  };
}

/** Stały katalog roboczy sesji planowania (niezależny od liczby repozytoriów — sesja da się zawsze wznowić). */
function planDir(task: Task) {
  return subdir("plan", task.key);
}

/** vk plan KEY — stała, wznawialna sesja planowania w repozytorium projektu. */
export async function planSession(taskKey: string): Promise<number> {
  const task = getTaskByKey(taskKey);
  if (listRepos(task.project_id).length === 0) throw new VkError("Projekt nie ma repozytoriów — dodaj je w UI (Ustawienia projektu) lub przez MCP");
  const cwd = planDir(task);
  const { res, args } = commonArgs("plan", task);
  const resume = sessionExists(task.plan_session_id);
  const head = resume
    ? ["--resume", task.plan_session_id]
    : [renderPrompt(promptTemplate(task, "plan"), task, undefined, res), "--session-id", task.plan_session_id];
  console.error(`[vk] ${resume ? "Wznawiam" : "Rozpoczynam"} sesję planowania ${task.key} (${task.plan_session_id})`);
  console.error(`[vk] Repozytoria: ${listRepos(task.project_id).map((r) => `${r.name} (${r.path})`).join(", ")}`);
  return runInteractive([...head, "-n", `vk plan ${task.key}`, ...args], cwd);
}

/**
 * vk open SUBKEY — stała sesja review w worktree podzadania (zna komentarze przez MCP).
 * vk open SUBKEY --agent — wznawia sesję subagenta, który implementował podzadanie.
 */
export async function openSession(subKey: string, opts: { agent?: boolean; fresh?: boolean }): Promise<number> {
  let sub = getSubtaskByKey(subKey);
  const task = getTask(sub.task_id);
  let cwd: string;
  if (sub.status === "done" || ["draft", "todo"].includes(sub.status)) {
    cwd = ensureTaskWorktree(task, subtaskRepo(sub));
  } else {
    sub = prepareSubtaskWorktree(sub.id);
    cwd = sub.worktree_path!;
  }
  const kind = "review" as const;
  const { res, args } = commonArgs(kind, task, sub);
  let head: string[];
  if (opts.agent) {
    if (!sub.agent_session_id || !sessionExists(sub.agent_session_id)) {
      throw new VkError(`Podzadanie ${sub.key} nie ma zapisanej sesji subagenta`);
    }
    head = ["--resume", sub.agent_session_id];
    console.error(`[vk] Wznawiam sesję subagenta ${sub.agent_session_id} (${sub.key}) w ${cwd}`);
  } else {
    let sid = sub.review_session_id;
    if (!sid || opts.fresh) {
      sid = randomUUID();
      sub = setSubtaskFields(sub.id, { review_session_id: sid });
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

/** vk exec SUBKEY — uruchamia subagenta (claude -p) dla jednego podzadania. */
export async function execSubtask(subKey: string, opts: { force?: boolean } = {}): Promise<Subtask> {
  let sub = getSubtaskByKey(subKey);
  const task = getTask(sub.task_id);
  if (!["todo", "blocked", "in_progress"].includes(sub.status)) {
    throw new VkError(`Podzadanie ${sub.key} ma status ${sub.status} — można uruchomić tylko todo/blocked`);
  }
  const notReady = listSubtasks(task.id).filter((s) => sub.depends_on.includes(s.key) && !["review", "done"].includes(s.status));
  if (notReady.length && !opts.force) {
    throw new VkError(`Zależności nie są gotowe: ${notReady.map((s) => `${s.key} (${s.status})`).join(", ")}. Użyj --force, aby uruchomić mimo to.`);
  }
  sub = prepareSubtaskWorktree(sub.id);
  const settings = getSettings();
  const sessionId = randomUUID();
  const logPath = path.join(subdir("logs", task.key), `${sub.key}-${Date.now()}.jsonl`);
  sub = setSubtaskFields(sub.id, { status: "in_progress", agent_session_id: sessionId, log_path: logPath, error: "" });

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

  sub = getSubtask(sub.id);
  if (sub.status === "in_progress") {
    if (code === 0) {
      commitAll(sub.worktree_path!, `${sub.key}: ${sub.title}`);
      sub = setSubtaskFields(sub.id, { status: "review" });
      console.log(`${prefix} → Review (agent zakończył bez vk_submit_for_review — zmiany zacommitowane automatycznie)`);
    } else {
      const dirty = sub.worktree_path && hasChanges(sub.worktree_path);
      sub = setSubtaskFields(sub.id, {
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
 * vk run KEY — realizuje podzadania zgodnie z kolejnością i zależnościami.
 * Podzadanie rusza, gdy wszystkie jego zależności są w review lub done.
 */
export async function runTask(taskKey: string, opts: { concurrency?: number } = {}): Promise<void> {
  const task = getTaskByKey(taskKey);
  if (listSubtasks(task.id).some((s) => s.status === "draft")) {
    console.log(`[vk] Uwaga: część podzadań jest w Draft (niezaakceptowana) — zostaną pominięte.`);
  }
  const limit = Math.max(1, opts.concurrency ?? (Number(getSettings().concurrency) || 1));
  const running = new Map<number, Promise<void>>();
  const failed = new Set<number>();

  for (;;) {
    const candidates = runnableSubtasks(task.id).filter((s) => !running.has(s.id) && !failed.has(s.id));
    while (running.size < limit && candidates.length) {
      const s = candidates.shift()!;
      const p = execSubtask(s.key)
        .then((r) => {
          if (r.status !== "review" && r.status !== "done") failed.add(s.id);
        })
        .catch((e) => {
          failed.add(s.id);
          setSubtaskFields(s.id, { status: "blocked", error: String((e as Error).message) });
          console.error(`[${s.key}] błąd: ${(e as Error).message}`);
        })
        .finally(() => running.delete(s.id));
      running.set(s.id, p);
    }
    if (running.size === 0) break;
    await Promise.race(running.values());
  }

  const subs = listSubtasks(task.id);
  const left = subs.filter((s) => s.status === "todo");
  console.log(`\n[vk] Koniec. Review: ${subs.filter((s) => s.status === "review").length}, ` +
    `blocked: ${subs.filter((s) => s.status === "blocked").length}, done: ${subs.filter((s) => s.status === "done").length}`);
  if (left.length) {
    console.log(`[vk] Czekają (zależności nie są gotowe): ${left.map((s) => `${s.key} ← ${s.depends_on.join(", ")}`).join("; ")}`);
  }
}

