import express, { type NextFunction, type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { commentView, itemContext } from "../core/context.js";
import { mergeStep, rebaseStep, removeStepWorktree, stepDiff, taskBranch, taskRepos, taskWorktreePath } from "../core/git.js";
import { uiDistPath } from "../core/paths.js";
import { addRepo } from "../core/repos.js";
import { sessionExists } from "../core/sessions.js";
import {
  acceptPlan,
  attachRepo,
  createComment,
  createItem,
  createResource,
  createTask,
  deleteComment,
  deleteItem,
  deleteRepo,
  deleteResource,
  deleteTask,
  derivedStatus,
  detachRepo,
  extractTicketId,
  getItem,
  getSettings,
  getTask,
  ITEM_STATUSES,
  LEVEL,
  listComments,
  listItems,
  listRepos,
  listResources,
  listTaskRepos,
  listTasks,
  reorderItems,
  setItemFields,
  updateComment,
  updateItem,
  updateRepo,
  updateSettings,
  updateTask,
  type Item,
  type ItemStatus,
  VkError,
} from "../core/repo.js";

type H = (req: Request, res: Response) => unknown;
const h = (fn: H) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (e) {
    next(e);
  }
};
const id = (req: Request, name = "id") => Number(req.params[name]);

function itemView(items: Item[], it: Item) {
  const cli = getSettings().cli_command || "vk";
  const isStep = it.level === LEVEL.STEP;
  return {
    ...it,
    display_status: derivedStatus(items, it),
    open_comments: isStep ? listComments(it.id, false).length : 0,
    commands: isStep
      ? {
          open: `${cli} open ${it.key}`,
          agent: it.agent_session_id ? `${cli} open ${it.key} --agent` : null,
          exec: `${cli} exec ${it.key}`,
        }
      : null,
  };
}

function taskView(tid: number) {
  const task = getTask(tid);
  const items = listItems(tid);
  const cli = getSettings().cli_command || "vk";
  return {
    task,
    repos: listTaskRepos(tid),
    items: items.map((i) => itemView(items, i)),
    resources: listResources("task", tid),
    commands: { plan: `${cli} plan ${task.key}`, run: `${cli} run ${task.key}`, plan_session_started: sessionExists(task.plan_session_id) },
    task_branch: taskBranch(task),
    task_repos: taskRepos(task).map((r) => ({ name: r.name, worktree: taskWorktreePath(task, r) })),
  };
}

function readLog(logPath: string | null, max = 400) {
  if (!logPath || !fs.existsSync(logPath)) return [];
  const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  const out: { kind: string; text: string }[] = [];
  for (const l of lines) {
    try {
      const ev = JSON.parse(l);
      if (ev.type === "assistant") {
        for (const c of ev.message?.content ?? []) {
          if (c.type === "text") out.push({ kind: "text", text: c.text });
          if (c.type === "tool_use") out.push({ kind: "tool", text: `${c.name} ${JSON.stringify(c.input).slice(0, 300)}` });
        }
      } else if (ev.type === "result") {
        out.push({ kind: "result", text: `${ev.subtype}${ev.result ? `: ${ev.result}` : ""}` });
      } else if (ev.type === "stderr") {
        out.push({ kind: "stderr", text: ev.text });
      }
    } catch {
      /* pomiń */
    }
  }
  return out.slice(-max);
}

function stepOnly(itemId: number) {
  const it = getItem(itemId);
  if (it.level !== LEVEL.STEP) throw new VkError(`${it.key} nie jest Krokiem`);
  return it;
}

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "5mb" }));

  // Ochrona przed DNS rebinding: tylko lokalne nagłówki Host.
  app.use((req, res, next) => {
    const host = (req.headers.host ?? "").split(":")[0];
    if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) return res.status(403).send("Forbidden");
    next();
  });

  app.get("/api/health", h(() => ({ ok: true })));

  // settings
  app.get("/api/settings", h(() => getSettings()));
  app.put("/api/settings", h((req) => (updateSettings(req.body ?? {}), getSettings())));

  // repozytoria (globalna lista)
  app.get("/api/repos", h(() => listRepos()));
  // body: { path, name?, base_branch?, test_command?, description? }
  app.post("/api/repos", h((req) => addRepo(req.body ?? {})));
  app.put("/api/repos/:id", h((req) => updateRepo(id(req), req.body ?? {})));
  app.delete("/api/repos/:id", h((req) => deleteRepo(id(req))));

  // tickety
  app.get(
    "/api/tasks",
    h(() =>
      listTasks().map((t) => {
        const steps = listItems(t.id).filter((i) => i.level === LEVEL.STEP);
        return { ...t, repos: listTaskRepos(t.id).map((r) => r.name), steps: steps.map((s) => ({ key: s.key, status: s.status })) };
      }),
    ),
  );
  // body: { title, ticket_url?, description?, assumptions?, links?, repos?: [nazwa|id] }
  app.post("/api/tasks", h((req) => taskView(createTask(req.body ?? {}).id)));
  app.get("/api/tasks/:id", h((req) => taskView(id(req))));
  app.put("/api/tasks/:id", h((req) => (updateTask(id(req), req.body), taskView(id(req)))));
  app.delete("/api/tasks/:id", h((req) => deleteTask(id(req))));
  app.post("/api/tasks/:id/repos", h((req) => (attachRepo(id(req), req.body.repo), taskView(id(req)))));
  app.delete("/api/tasks/:id/repos/:repoId", h((req) => (detachRepo(id(req), id(req, "repoId")), taskView(id(req)))));
  app.post("/api/tasks/:id/accept-plan", h((req) => (acceptPlan(id(req), req.body?.root), taskView(id(req)))));
  app.post("/api/tasks/:id/reorder", h((req) => (reorderItems(id(req), req.body.order ?? []), taskView(id(req)))));
  app.get("/api/ticket-id", h((req) => ({ ticket_id: extractTicketId(String(req.query.url ?? "")) })));

  // elementy planu; body: { level: 1|2|3, parent?, repo?, kind?, title, description?, problem?, acceptance?, depends_on? }
  app.post(
    "/api/tasks/:id/items",
    h((req) => {
      const level = Number(req.body.level);
      if (![1, 2, 3].includes(level)) throw new VkError("level musi być 1 (Etap), 2 (Funkcja) lub 3 (Krok)");
      const it = createItem(id(req), level, req.body, req.body.status === "todo" ? "todo" : "draft");
      return itemView(listItems(it.task_id), it);
    }),
  );
  app.get(
    "/api/items/:id",
    h((req) => {
      const it = getItem(id(req));
      return { ...itemView(listItems(it.task_id), it), context: itemContext(it) };
    }),
  );
  app.put(
    "/api/items/:id",
    h((req) => {
      const it = updateItem(id(req), req.body ?? {});
      return itemView(listItems(it.task_id), it);
    }),
  );
  app.delete(
    "/api/items/:id",
    h((req) => {
      const it = getItem(id(req));
      for (const s of listItems(it.task_id).filter((i) => i.key === it.key || i.key.startsWith(`${it.key}.`))) removeStepWorktree(s);
      deleteItem(it.id);
    }),
  );
  app.post(
    "/api/items/:id/status",
    h((req) => {
      const it = getItem(id(req));
      const status = req.body.status as ItemStatus;
      const allowed: ItemStatus[] = it.level === LEVEL.STEP ? ITEM_STATUSES.filter((s) => s !== "done") : ["draft", "todo"];
      if (!allowed.includes(status)) throw new VkError("Niedozwolony status (Done tylko przez akceptację Kroku)");
      setItemFields(it.id, { status, ...(status === "todo" ? { error: "" } : {}) });
      const fresh = getItem(it.id);
      return itemView(listItems(fresh.task_id), fresh);
    }),
  );
  app.post("/api/items/:id/merge", h((req) => (mergeStep(stepOnly(id(req)).id), { ok: true })));
  app.post("/api/items/:id/rebase", h((req) => (rebaseStep(stepOnly(id(req)).id), { ok: true })));
  app.get("/api/items/:id/diff", h((req) => stepDiff(stepOnly(id(req)))));
  app.get("/api/items/:id/log", h((req) => readLog(getItem(id(req)).log_path)));

  // komentarze
  app.get("/api/items/:id/comments", h((req) => listComments(id(req)).map(commentView)));
  app.post("/api/items/:id/comments", h((req) => commentView(createComment(id(req), req.body))));
  app.put("/api/comments/:id", h((req) => commentView(updateComment(id(req), req.body))));
  app.delete("/api/comments/:id", h((req) => deleteComment(id(req))));

  // zasoby referencyjne
  app.get("/api/resources", h((req) => listResources(String(req.query.scope ?? "global") === "task" ? "task" : "global", req.query.scope_id ? Number(req.query.scope_id) : null)));
  app.post("/api/resources", h((req) => createResource(req.body)));
  app.delete("/api/resources/:id", h((req) => deleteResource(id(req))));

  app.use("/api", (_req, res) => res.status(404).json({ error: "Nie znaleziono" }));

  // UI
  const ui = uiDistPath();
  if (fs.existsSync(ui)) {
    app.use(express.static(ui));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(ui, "index.html")));
  } else {
    app.get("/", (_req, res) => res.send("Brak zbudowanego UI — uruchom npm run build"));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof VkError ? err.status : 500;
    res.status(status).json({ error: (err as Error).message ?? String(err) });
  });

  return app;
}

export function startHttpServer(port: number, host = "127.0.0.1") {
  const app = createApp();
  return new Promise<void>((resolve) => {
    app.listen(port, host, () => {
      console.log(`vibe-kanban: http://localhost:${port} (nasłuch ${host})`);
      resolve();
    });
  });
}
