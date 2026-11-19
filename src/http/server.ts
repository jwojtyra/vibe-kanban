import express, { type NextFunction, type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { commentView, subtaskContext } from "../core/context.js";
import { mergeSubtask, rebaseSubtask, removeSubtaskWorktree, subtaskDiff, taskBranch, taskRepos, taskWorktreePath } from "../core/git.js";
import { addRepo, createProjectWithRepos, projectView } from "../core/projects.js";
import { uiDistPath } from "../core/paths.js";
import { sessionExists } from "../core/sessions.js";
import {
  acceptPlan,
  createComment,
  createResource,
  createSubtask,
  createTask,
  deleteComment,
  deleteProject,
  deleteRepo,
  deleteResource,
  deleteSubtask,
  deleteTask,
  extractTicketId,
  getProject,
  getSettings,
  getSubtask,
  getTask,
  listComments,
  listProjects,
  listRepos,
  listResources,
  listSubtasks,
  listTasks,
  reorderSubtasks,
  setSubtaskFields,
  SUBTASK_STATUSES,
  type SubtaskStatus,
  type Task,
  updateComment,
  updateProject,
  updateRepo,
  updateSettings,
  updateSubtask,
  updateTask,
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

function commands(task: Task) {
  const cli = getSettings().cli_command || "vk";
  return {
    plan: `${cli} plan ${task.key}`,
    run: `${cli} run ${task.key}`,
    plan_session_started: sessionExists(task.plan_session_id),
  };
}

function subtaskView(sid: number) {
  const s = getSubtask(sid);
  const cli = getSettings().cli_command || "vk";
  const comments = listComments(s.id, true);
  return {
    ...s,
    open_comments: comments.filter((c) => !c.resolved).length,
    commands: {
      open: `${cli} open ${s.key}`,
      agent: s.agent_session_id ? `${cli} open ${s.key} --agent` : null,
      exec: `${cli} exec ${s.key}`,
    },
  };
}

function taskView(tid: number) {
  const task = getTask(tid);
  return {
    task,
    project: projectView(getProject(task.project_id)),
    subtasks: listSubtasks(tid).map((s) => subtaskView(s.id)),
    resources: listResources("task", tid),
    commands: commands(task),
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

  // projects
  app.get("/api/projects", h(() => listProjects().map(projectView)));
  // body: { name, description?, assumptions?, repos?: [{ path, name?, base_branch?, description? }] }
  app.post("/api/projects", h((req) => createProjectWithRepos(req.body ?? {})));
  app.get("/api/projects/:id", h((req) => projectView(getProject(id(req)))));
  app.put("/api/projects/:id", h((req) => projectView(updateProject(id(req), req.body))));
  app.delete("/api/projects/:id", h((req) => deleteProject(id(req))));

  // repos
  app.get("/api/projects/:id/repos", h((req) => listRepos(id(req))));
  app.post("/api/projects/:id/repos", h((req) => addRepo(id(req), req.body ?? {})));
  app.put("/api/repos/:id", h((req) => updateRepo(id(req), req.body ?? {})));
  app.delete("/api/repos/:id", h((req) => deleteRepo(id(req))));

  // tasks
  app.get("/api/projects/:id/tasks", h((req) => listTasks(id(req)).map((t) => ({ ...t, subtasks: listSubtasks(t.id).map((s) => ({ key: s.key, status: s.status })) }))));
  app.post("/api/projects/:id/tasks", h((req) => taskView(createTask({ ...req.body, project_id: id(req) }).id)));
  app.get("/api/tasks/:id", h((req) => taskView(id(req))));
  app.put("/api/tasks/:id", h((req) => (updateTask(id(req), req.body), taskView(id(req)))));
  app.delete("/api/tasks/:id", h((req) => deleteTask(id(req))));
  app.post("/api/tasks/:id/accept-plan", h((req) => (acceptPlan(id(req)), taskView(id(req)))));
  app.post("/api/tasks/:id/reorder", h((req) => (reorderSubtasks(id(req), req.body.order ?? []), taskView(id(req)))));
  app.get("/api/ticket-id", h((req) => ({ ticket_id: extractTicketId(String(req.query.url ?? "")) })));

  // subtasks
  app.post("/api/tasks/:id/subtasks", h((req) => subtaskView(createSubtask(id(req), req.body, req.body.status === "todo" ? "todo" : "draft").id)));
  app.get("/api/subtasks/:id", h((req) => ({ ...subtaskView(id(req)), context: subtaskContext(getSubtask(id(req))) })));
  app.put("/api/subtasks/:id", h((req) => (updateSubtask(id(req), req.body), subtaskView(id(req)))));
  app.delete(
    "/api/subtasks/:id",
    h((req) => {
      const s = getSubtask(id(req));
      removeSubtaskWorktree(s);
      deleteSubtask(s.id);
    }),
  );
  app.post(
    "/api/subtasks/:id/status",
    h((req) => {
      const status = req.body.status as SubtaskStatus;
      if (!SUBTASK_STATUSES.includes(status) || status === "done") throw new VkError("Niedozwolony status (Done tylko przez akceptację)");
      setSubtaskFields(id(req), { status, ...(status === "todo" ? { error: "" } : {}) });
      return subtaskView(id(req));
    }),
  );
  app.post("/api/subtasks/:id/merge", h((req) => (mergeSubtask(id(req)), subtaskView(id(req)))));
  app.post("/api/subtasks/:id/rebase", h((req) => (rebaseSubtask(id(req)), subtaskView(id(req)))));
  app.get("/api/subtasks/:id/diff", h((req) => subtaskDiff(getSubtask(id(req)))));
  app.get("/api/subtasks/:id/log", h((req) => readLog(getSubtask(id(req)).log_path)));

  // comments
  app.get("/api/subtasks/:id/comments", h((req) => listComments(id(req)).map(commentView)));
  app.post("/api/subtasks/:id/comments", h((req) => commentView(createComment(id(req), req.body))));
  app.put("/api/comments/:id", h((req) => commentView(updateComment(id(req), req.body))));
  app.delete("/api/comments/:id", h((req) => deleteComment(id(req))));

  // resources
  app.get(
    "/api/resources",
    h((req) => listResources(String(req.query.scope ?? "global") as "global" | "project" | "task", req.query.scope_id ? Number(req.query.scope_id) : null)),
  );
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
