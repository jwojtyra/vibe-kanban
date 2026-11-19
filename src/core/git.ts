import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { slug, subdir } from "./paths.js";
import {
  getProject,
  getRepo,
  getSubtask,
  getTask,
  listRepos,
  listSubtasks,
  setSubtaskFields,
  type Repo,
  type Subtask,
  type Task,
  VkError,
} from "./repo.js";

export function git(cwd: string, args: string[], opts: { allowFail?: boolean } = {}): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !opts.allowFail) {
    throw new VkError(`git ${args.join(" ")} (w ${cwd}): ${(r.stderr || r.stdout || "").trim()}`);
  }
  return (r.stdout ?? "").trimEnd();
}

function gitOk(cwd: string, args: string[]): boolean {
  return spawnSync("git", args, { cwd, encoding: "utf8" }).status === 0;
}

export function isGitRepo(p: string): boolean {
  return fs.existsSync(p) && gitOk(p, ["rev-parse", "--git-dir"]);
}

export function currentBranch(repo: string): string {
  return git(repo, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true }) || "main";
}

export function branchExists(repo: string, branch: string): boolean {
  return gitOk(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
}

export function taskBranch(task: Task) {
  return `vk/${task.key}`;
}

export function subtaskBranch(sub: Subtask) {
  return `vk/${sub.key}`;
}

function worktreeRoot(repo: Repo) {
  const project = getProject(repo.project_id);
  return subdir("worktrees", `${slug(project.name)}-${project.id}`, slug(repo.name));
}

/** Ścieżka worktree, w którym gałąź jest już wyewidencjonowana (albo null). */
function worktreeOfBranch(repoPath: string, branch: string): string | null {
  const out = git(repoPath, ["worktree", "list", "--porcelain"], { allowFail: true });
  let cur: string | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) cur = line.slice(9);
    if (line === `branch refs/heads/${branch}` && cur && fs.existsSync(cur)) return cur;
  }
  return null;
}

/** Tworzy worktree (lub zwraca istniejący dla tej gałęzi). Zwraca faktyczną ścieżkę. */
function ensureWorktree(repo: Repo, dir: string, branch: string, startPoint: string): string {
  if (fs.existsSync(dir) && isGitRepo(dir)) return dir;
  git(repo.path, ["worktree", "prune"], { allowFail: true });
  const existing = worktreeOfBranch(repo.path, branch);
  if (existing) return existing;
  if (branchExists(repo.path, branch)) {
    git(repo.path, ["worktree", "add", dir, branch]);
  } else {
    git(repo.path, ["worktree", "add", "-b", branch, dir, startPoint]);
  }
  return dir;
}

/** Repozytorium podzadania (z bazy). */
export function subtaskRepo(sub: Subtask): Repo {
  if (sub.repo_id == null) throw new VkError(`Podzadanie ${sub.key} nie ma przypisanego repozytorium`);
  return getRepo(sub.repo_id);
}

export function taskWorktreePath(task: Task, repo: Repo): string {
  return path.join(worktreeRoot(repo), task.key);
}

/** Worktree gałęzi zadania w danym repozytorium (tu lądują merge'e zaakceptowanych podzadań). */
export function ensureTaskWorktree(task: Task, repo: Repo): string {
  if (!isGitRepo(repo.path)) throw new VkError(`${repo.path} (repo ${repo.name}) nie jest dostępnym repozytorium git`);
  if (!gitOk(repo.path, ["rev-parse", "--verify", repo.base_branch])) {
    throw new VkError(`Gałąź bazowa "${repo.base_branch}" nie istnieje w repo ${repo.name} (${repo.path})`);
  }
  return ensureWorktree(repo, taskWorktreePath(task, repo), taskBranch(task), repo.base_branch);
}

/** Repozytoria, których dotyczą podzadania zadania (gałąź zadania jest tworzona tylko w nich). */
export function taskRepos(task: Task): Repo[] {
  const used = new Set(listSubtasks(task.id).map((s) => s.repo_id));
  return listRepos(task.project_id).filter((r) => used.has(r.id));
}

/**
 * Baza podzadania: gałąź zadania w jego repo, a jeśli któraś zależność z TEGO SAMEGO repo
 * nie jest jeszcze done — gałąź ostatniej takiej zależności (stacked). Zależności z innych
 * repozytoriów wpływają tylko na kolejność, nie na bazę.
 */
export function computeBaseRef(sub: Subtask): string {
  const task = getTask(sub.task_id);
  const pending = listSubtasks(task.id).filter(
    (s) => sub.depends_on.includes(s.key) && s.repo_id === sub.repo_id && s.status !== "done" && s.branch,
  );
  if (pending.length === 0) return taskBranch(task);
  pending.sort((a, b) => b.position - a.position);
  return pending[0].branch!;
}

/** Tworzy gałąź i worktree podzadania (jeśli jeszcze nie istnieją). */
export function prepareSubtaskWorktree(subId: number): Subtask {
  let sub = getSubtask(subId);
  const task = getTask(sub.task_id);
  const repo = subtaskRepo(sub);
  ensureTaskWorktree(task, repo);
  const branch = subtaskBranch(sub);
  const baseRef = sub.base_ref ?? computeBaseRef(sub);
  const dir = ensureWorktree(repo, path.join(worktreeRoot(repo), sub.key), branch, baseRef);
  sub = setSubtaskFields(sub.id, { branch, worktree_path: dir, base_ref: baseRef });
  return sub;
}

export function hasChanges(dir: string): boolean {
  return git(dir, ["status", "--porcelain"]).length > 0;
}

/** Commituje wszystkie zmiany w worktree (jeśli są). Zwraca true, gdy powstał commit. */
export function commitAll(dir: string, message: string): boolean {
  if (!hasChanges(dir)) return false;
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", message, "--no-verify"]);
  return true;
}

export interface SubtaskDiff {
  repo: string;
  base: string;
  baseRef: string;
  diff: string;
  commits: string;
  needsRebase: boolean;
  uncommitted: boolean;
}

export function subtaskDiff(sub: Subtask): SubtaskDiff {
  const empty = { repo: sub.repo ?? "", base: "", baseRef: sub.base_ref ?? "", diff: "", commits: "", needsRebase: false, uncommitted: false };
  if (sub.repo_id == null) return empty;
  const repo = subtaskRepo(sub);
  if (!sub.worktree_path || !fs.existsSync(sub.worktree_path) || !sub.base_ref) {
    // po done worktree jest usunięty — pokazujemy diff z gałęzi
    const task = getTask(sub.task_id);
    if (sub.branch && sub.base_ref && isGitRepo(repo.path) && branchExists(repo.path, sub.branch)) {
      const baseRef = branchExists(repo.path, sub.base_ref) ? sub.base_ref : taskBranch(task);
      const base = git(repo.path, ["merge-base", baseRef, sub.branch], { allowFail: true });
      if (base) {
        return {
          ...empty,
          base,
          baseRef,
          diff: git(repo.path, ["diff", "--no-color", "-M", base, sub.branch]),
          commits: git(repo.path, ["log", "--oneline", `${base}..${sub.branch}`]),
        };
      }
    }
    return empty;
  }
  const dir = sub.worktree_path;
  const baseRef = sub.base_ref;
  const base = git(dir, ["merge-base", baseRef, "HEAD"]);
  let diff = git(dir, ["diff", "--no-color", "-M", base]);
  const untracked = git(dir, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
  for (const f of untracked) {
    const r = spawnSync("git", ["diff", "--no-color", "--no-index", "/dev/null", f], { cwd: dir, encoding: "utf8" });
    if (r.stdout) diff += (diff ? "\n" : "") + r.stdout.trimEnd();
  }
  const tip = git(dir, ["rev-parse", baseRef]);
  return {
    repo: repo.name,
    base,
    baseRef,
    diff,
    commits: git(dir, ["log", "--oneline", `${base}..HEAD`]),
    needsRebase: tip !== base,
    uncommitted: hasChanges(dir),
  };
}

/** Rebase podzadania na aktualną bazę. Przy konflikcie wycofuje się i zgłasza błąd. */
export function rebaseSubtask(subId: number): Subtask {
  let sub = getSubtask(subId);
  if (!sub.worktree_path) throw new VkError("Podzadanie nie ma worktree");
  // jeśli zależności są już done, baza przechodzi na gałąź zadania
  const newBase = computeBaseRef(sub);
  if (newBase !== sub.base_ref) sub = setSubtaskFields(sub.id, { base_ref: newBase });
  const dir = sub.worktree_path!;
  if (hasChanges(dir)) throw new VkError("Worktree ma niezacommitowane zmiany — najpierw commit");
  const r = spawnSync("git", ["rebase", newBase], { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) {
    spawnSync("git", ["rebase", "--abort"], { cwd: dir });
    throw new VkError(`Konflikt podczas rebase na ${newBase}. Rozwiąż go w sesji (vk open ${sub.key}).\n${r.stdout}${r.stderr}`);
  }
  return sub;
}

/**
 * Akceptacja podzadania: commit ewentualnych zmian, merge --no-ff do gałęzi zadania w repo
 * podzadania, usunięcie worktree podzadania (gałąź zostaje), przełączenie zależnych na gałąź zadania.
 */
export function mergeSubtask(subId: number): Subtask {
  let sub = getSubtask(subId);
  const task = getTask(sub.task_id);
  const repo = subtaskRepo(sub);
  if (!sub.branch || !branchExists(repo.path, sub.branch)) throw new VkError("Podzadanie nie ma gałęzi do scalenia");
  if (sub.worktree_path && fs.existsSync(sub.worktree_path)) {
    commitAll(sub.worktree_path, `${sub.key}: poprawki z review`);
  }
  const notDoneDeps = listSubtasks(task.id).filter((s) => sub.depends_on.includes(s.key) && s.status !== "done");
  if (notDoneDeps.length) {
    throw new VkError(`Najpierw zaakceptuj zależności: ${notDoneDeps.map((s) => s.key).join(", ")}`);
  }
  const taskDir = ensureTaskWorktree(task, repo);
  if (hasChanges(taskDir)) throw new VkError(`Worktree zadania (${taskDir}) ma niezacommitowane zmiany`);
  const r = spawnSync("git", ["merge", "--no-ff", sub.branch, "-m", `${sub.key}: ${sub.title}`], { cwd: taskDir, encoding: "utf8" });
  if (r.status !== 0) {
    spawnSync("git", ["merge", "--abort"], { cwd: taskDir });
    throw new VkError(`Konflikt przy scalaniu ${sub.branch} do ${taskBranch(task)} (repo ${repo.name}). Zrób rebase.\n${r.stdout}${r.stderr}`);
  }
  if (sub.worktree_path && fs.existsSync(sub.worktree_path)) {
    git(repo.path, ["worktree", "remove", "--force", sub.worktree_path], { allowFail: true });
  }
  sub = setSubtaskFields(sub.id, { status: "done", worktree_path: null, error: "" });
  for (const s of listSubtasks(task.id)) {
    if (s.id === sub.id || !s.depends_on.includes(sub.key) || !s.base_ref) continue;
    setSubtaskFields(s.id, { base_ref: computeBaseRef(s) });
  }
  return sub;
}

export function removeSubtaskWorktree(sub: Subtask) {
  if (sub.repo_id == null || !sub.worktree_path || !fs.existsSync(sub.worktree_path)) return;
  git(subtaskRepo(sub).path, ["worktree", "remove", "--force", sub.worktree_path], { allowFail: true });
}

/** Klonuje (płytko) repozytorium zasobu do cache, jeśli jeszcze go nie ma. */
export function ensureGitResource(url: string): string {
  const dir = path.join(subdir("cache"), slug(url.replace(/^(https?:\/\/|git@|ssh:\/\/)/, "")));
  if (!fs.existsSync(path.join(dir, ".git"))) {
    execFileSync("git", ["clone", "--depth", "1", url, dir], { stdio: ["ignore", 2, 2] });
  }
  return dir;
}
