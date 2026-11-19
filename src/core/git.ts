import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { slug, subdir } from "./paths.js";
import {
  getProject,
  getSubtask,
  getTask,
  listSubtasks,
  setSubtaskFields,
  type Project,
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

function worktreeRoot(project: Project) {
  return subdir("worktrees", `${slug(project.name)}-${project.id}`);
}

function ensureWorktree(project: Project, dir: string, branch: string, startPoint: string) {
  if (fs.existsSync(dir) && isGitRepo(dir)) return;
  git(project.repo_path, ["worktree", "prune"], { allowFail: true });
  if (branchExists(project.repo_path, branch)) {
    git(project.repo_path, ["worktree", "add", dir, branch]);
  } else {
    git(project.repo_path, ["worktree", "add", "-b", branch, dir, startPoint]);
  }
}

/** Worktree gałęzi zadania (tu lądują merge'e zaakceptowanych podzadań). */
export function ensureTaskWorktree(task: Task): string {
  const project = getProject(task.project_id);
  const dir = path.join(worktreeRoot(project), task.key);
  if (!branchExists(project.repo_path, project.base_branch) && !gitOk(project.repo_path, ["rev-parse", "--verify", project.base_branch])) {
    throw new VkError(`Gałąź bazowa "${project.base_branch}" nie istnieje w ${project.repo_path}`);
  }
  ensureWorktree(project, dir, taskBranch(task), project.base_branch);
  return dir;
}

export function taskWorktreePath(task: Task): string {
  const project = getProject(task.project_id);
  return path.join(worktreeRoot(project), task.key);
}

/**
 * Wyznacza bazę podzadania: gałąź zadania, a jeśli któraś zależność nie jest jeszcze done —
 * gałąź ostatniej (wg kolejności) takiej zależności (stacked).
 */
export function computeBaseRef(sub: Subtask): string {
  const task = getTask(sub.task_id);
  const all = listSubtasks(task.id);
  const pending = all.filter((s) => sub.depends_on.includes(s.key) && s.status !== "done" && s.branch);
  if (pending.length === 0) return taskBranch(task);
  pending.sort((a, b) => b.position - a.position);
  return pending[0].branch!;
}

/** Tworzy gałąź i worktree podzadania (jeśli jeszcze nie istnieją). */
export function prepareSubtaskWorktree(subId: number): Subtask {
  let sub = getSubtask(subId);
  const task = getTask(sub.task_id);
  const project = getProject(task.project_id);
  ensureTaskWorktree(task);
  const branch = subtaskBranch(sub);
  const dir = path.join(worktreeRoot(project), sub.key);
  const baseRef = sub.base_ref ?? computeBaseRef(sub);
  ensureWorktree(project, dir, branch, baseRef);
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
  base: string;
  baseRef: string;
  diff: string;
  commits: string;
  needsRebase: boolean;
  uncommitted: boolean;
}

export function subtaskDiff(sub: Subtask): SubtaskDiff {
  if (!sub.worktree_path || !fs.existsSync(sub.worktree_path) || !sub.base_ref) {
    // po done worktree jest usunięty — pokazujemy diff z gałęzi
    const task = getTask(sub.task_id);
    const project = getProject(task.project_id);
    if (sub.branch && branchExists(project.repo_path, sub.branch) && sub.base_ref) {
      const repo = project.repo_path;
      const baseRef = branchExists(repo, sub.base_ref) ? sub.base_ref : taskBranch(task);
      const base = git(repo, ["merge-base", baseRef, sub.branch], { allowFail: true });
      if (base) {
        return {
          base,
          baseRef,
          diff: git(repo, ["diff", "--no-color", "-M", base, sub.branch]),
          commits: git(repo, ["log", "--oneline", `${base}..${sub.branch}`]),
          needsRebase: false,
          uncommitted: false,
        };
      }
    }
    return { base: "", baseRef: sub.base_ref ?? "", diff: "", commits: "", needsRebase: false, uncommitted: false };
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
 * Akceptacja podzadania: commit ewentualnych zmian, merge --no-ff do gałęzi zadania,
 * usunięcie worktree podzadania (gałąź zostaje), przełączenie zależnych na gałąź zadania.
 */
export function mergeSubtask(subId: number): Subtask {
  let sub = getSubtask(subId);
  const task = getTask(sub.task_id);
  const project = getProject(task.project_id);
  if (!sub.branch || !branchExists(project.repo_path, sub.branch)) throw new VkError("Podzadanie nie ma gałęzi do scalenia");
  if (sub.worktree_path && fs.existsSync(sub.worktree_path)) {
    commitAll(sub.worktree_path, `${sub.key}: poprawki z review`);
  }
  const all = listSubtasks(task.id);
  const notDoneDeps = all.filter((s) => sub.depends_on.includes(s.key) && s.status !== "done");
  if (notDoneDeps.length) {
    throw new VkError(`Najpierw zaakceptuj zależności: ${notDoneDeps.map((s) => s.key).join(", ")}`);
  }
  const taskDir = ensureTaskWorktree(task);
  if (hasChanges(taskDir)) throw new VkError(`Worktree zadania (${taskDir}) ma niezacommitowane zmiany`);
  const r = spawnSync("git", ["merge", "--no-ff", sub.branch, "-m", `${sub.key}: ${sub.title}`], { cwd: taskDir, encoding: "utf8" });
  if (r.status !== 0) {
    spawnSync("git", ["merge", "--abort"], { cwd: taskDir });
    throw new VkError(`Konflikt przy scalaniu ${sub.branch} do ${taskBranch(task)}. Zrób rebase (przycisk Rebase lub w sesji).\n${r.stdout}${r.stderr}`);
  }
  if (sub.worktree_path && fs.existsSync(sub.worktree_path)) {
    git(project.repo_path, ["worktree", "remove", "--force", sub.worktree_path], { allowFail: true });
  }
  sub = setSubtaskFields(sub.id, { status: "done", worktree_path: null, error: "" });
  // zależne podzadania: jeśli wszystkie ich zależności są done -> baza = gałąź zadania
  for (const s of listSubtasks(task.id)) {
    if (s.id === sub.id || !s.depends_on.includes(sub.key) || !s.base_ref) continue;
    setSubtaskFields(s.id, { base_ref: computeBaseRef(s) });
  }
  return sub;
}

export function removeSubtaskWorktree(sub: Subtask) {
  const task = getTask(sub.task_id);
  const project = getProject(task.project_id);
  if (sub.worktree_path && fs.existsSync(sub.worktree_path)) {
    git(project.repo_path, ["worktree", "remove", "--force", sub.worktree_path], { allowFail: true });
  }
}

/** Klonuje (płytko) repozytorium zasobu do cache, jeśli jeszcze go nie ma. */
export function ensureGitResource(url: string): string {
  const dir = path.join(subdir("cache"), slug(url.replace(/^(https?:\/\/|git@|ssh:\/\/)/, "")));
  if (!fs.existsSync(path.join(dir, ".git"))) {
    execFileSync("git", ["clone", "--depth", "1", url, dir], { stdio: ["ignore", 2, 2] });
  }
  return dir;
}

export function updateGitResource(url: string): string {
  const dir = ensureGitResource(url);
  git(dir, ["pull", "--ff-only"], { allowFail: true });
  return dir;
}
