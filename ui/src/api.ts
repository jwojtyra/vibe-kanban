export type SubtaskStatus = "draft" | "todo" | "in_progress" | "review" | "done" | "blocked";

export interface Repo {
  id: number;
  project_id: number;
  name: string;
  path: string;
  base_branch: string;
  description: string;
}

export interface Project {
  id: number;
  name: string;
  description: string;
  assumptions: string;
  repos: Repo[];
}

export interface Link {
  url: string;
  note?: string;
}

export interface Task {
  id: number;
  project_id: number;
  key: string;
  title: string;
  description: string;
  ticket_url: string;
  ticket_id: string;
  assumptions: string;
  links: Link[];
  plan_prompt: string | null;
  impl_prompt: string | null;
  review_prompt: string | null;
  status: string;
  plan_session_id: string;
  subtasks?: { key: string; status: SubtaskStatus }[];
}

export interface Subtask {
  id: number;
  task_id: number;
  key: string;
  number: number;
  position: number;
  title: string;
  description: string;
  problem: string;
  acceptance: string;
  status: SubtaskStatus;
  repo_id: number | null;
  repo: string | null;
  branch: string | null;
  worktree_path: string | null;
  base_ref: string | null;
  agent_session_id: string | null;
  review_session_id: string | null;
  summary: string;
  error: string;
  depends_on: string[];
  open_comments: number;
  commands: { open: string; agent: string | null; exec: string };
}

export interface Resource {
  id: number;
  scope: "global" | "project" | "task";
  scope_id: number | null;
  name: string;
  kind: "path" | "git";
  location: string;
  note: string;
}

export interface Comment {
  id: number;
  file: string | null;
  line: number | null;
  side: string | null;
  line_text: string | null;
  body: string;
  resolved: boolean;
  resolution?: string;
}

export interface TaskView {
  task: Task;
  project: Project;
  subtasks: Subtask[];
  resources: Resource[];
  commands: { plan: string; run: string; plan_session_started: boolean };
  task_branch: string;
  task_repos: { name: string; worktree: string }[];
}

export interface DiffResult {
  repo: string;
  base: string;
  baseRef: string;
  diff: string;
  commits: string;
  needsRebase: boolean;
  uncommitted: boolean;
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${r.status}`);
  return data as T;
}

export const api = {
  get: <T>(url: string) => req<T>("GET", url),
  post: <T>(url: string, body?: unknown) => req<T>("POST", url, body ?? {}),
  put: <T>(url: string, body: unknown) => req<T>("PUT", url, body),
  del: <T>(url: string) => req<T>("DELETE", url),
};

export const STATUS_LABEL: Record<SubtaskStatus, string> = {
  draft: "Draft",
  todo: "Todo",
  in_progress: "W trakcie",
  review: "Review",
  done: "Done",
  blocked: "Blocked",
};

export const COLUMNS: SubtaskStatus[] = ["draft", "todo", "in_progress", "review", "done", "blocked"];
