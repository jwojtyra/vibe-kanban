export type ItemStatus = "draft" | "todo" | "in_progress" | "review" | "done" | "blocked";

export interface Repo {
  id: number;
  name: string;
  path: string;
  base_branch: string;
  test_command: string;
  description: string;
}

export interface Link {
  url: string;
  note?: string;
}

export interface Task {
  id: number;
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
  repos?: string[];
  steps?: { key: string; status: ItemStatus }[];
  open_questions?: number;
  blockers?: number;
}

export interface Question {
  id: number;
  task_id: number;
  item_id: number | null;
  item_key: string | null;
  question: string;
  options: string[];
  blocking: boolean;
  status: "open" | "answered" | "closed";
  answer_choice: string | null;
  answer_text: string;
  note: string;
  created_at: string;
  answered_at: string | null;
}

export type Attention = "blocker" | "question" | null;

export interface Item {
  id: number;
  task_id: number;
  parent_id: number | null;
  level: 1 | 2 | 3;
  key: string;
  position: number;
  title: string;
  description: string;
  problem: string;
  acceptance: string;
  kind: "test" | "impl";
  status: ItemStatus;
  display_status: ItemStatus;
  repo_id: number | null;
  repo: string | null;
  branch: string | null;
  worktree_path: string | null;
  base_ref: string | null;
  agent_session_id: string | null;
  review_session_id: string | null;
  summary: string;
  error: string;
  blocker: string;
  attention: Attention;
  open_questions: number;
  block_reasons: string[];
  depends_on: string[];
  open_comments: number;
  commands: { open: string; agent: string | null; exec: string } | null;
}

export interface Resource {
  id: number;
  scope: "global" | "task";
  scope_id: number | null;
  name: string;
  kind: "path" | "git";
  location: string;
  note: string;
}

export interface Attachment {
  id: number;
  task_id: number;
  name: string;
  size: number;
  mime: string;
  note: string;
  extracted: string | null;
  extract_info: string;
  created_at: string;
  kind: "image" | "archive" | "file";
  local_path: string;
  extracted_path: string | null;
  files?: string[];
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
  repos: Repo[];
  items: Item[];
  questions: Question[];
  resources: Resource[];
  attachments: Attachment[];
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

export const STATUS_LABEL: Record<ItemStatus, string> = {
  draft: "Draft",
  todo: "Todo",
  in_progress: "W trakcie",
  review: "Review",
  done: "Done",
  blocked: "Blocked",
};

export const LEVEL_NAME: Record<number, string> = { 1: "Etap", 2: "Funkcja", 3: "Krok" };

export const COLUMNS: ItemStatus[] = ["draft", "todo", "in_progress", "review", "done", "blocked"];

/** Krótki klucz elementu bez klucza ticketu, np. "1.2.3". */
export const shortKey = (taskKey: string, key: string) => (key.startsWith(`${taskKey}-`) ? key.slice(taskKey.length + 1) : key);
