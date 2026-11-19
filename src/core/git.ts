import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { slug, subdir } from "./paths.js";
import {
  effectiveDeps,
  getItem,
  getRepo,
  getTask,
  listItems,
  listSteps,
  listTaskRepos,
  setItemFields,
  type Item,
  type Repo,
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

export function stepBranch(step: Item) {
  return `vk/${step.key}`;
}

function worktreeRoot(repo: Repo) {
  return subdir("worktrees", `${slug(repo.name)}-${repo.id}`);
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

/** Repozytorium Kroku. */
export function stepRepo(step: Item): Repo {
  if (step.repo_id == null) throw new VkError(`${step.key} nie ma przypisanego repozytorium`);
  return getRepo(step.repo_id);
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

/** Repozytoria ticketu, w których są Kroki (gałąź zadania powstaje tylko w nich). */
export function taskRepos(task: Task): Repo[] {
  const used = new Set(listSteps(task.id).map((s) => s.repo_id));
  return listTaskRepos(task.id).filter((r) => used.has(r.id));
}

/**
 * Baza Kroku: gałąź zadania w jego repo, a jeśli któraś efektywna zależność z TEGO SAMEGO repo
 * nie jest jeszcze done — gałąź ostatniej (w kolejności planu) takiej zależności (stacked),
 * np. Krok implementacji startuje z gałęzi Kroku z czerwonymi testami.
 * Zależności z innych repozytoriów wpływają tylko na kolejność.
 */
export function computeBaseRef(step: Item): string {
  const task = getTask(step.task_id);
  const items = listItems(task.id);
  const order = new Map(items.map((i, idx) => [i.id, idx]));
  const pending = effectiveDeps(items, items.find((i) => i.id === step.id) ?? step).filter(
    (s) => s.repo_id === step.repo_id && s.status !== "done" && s.branch,
  );
  if (pending.length === 0) return taskBranch(task);
  pending.sort((a, b) => (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0));
  return pending[0].branch!;
}

/** Tworzy gałąź i worktree Kroku (jeśli jeszcze nie istnieją). */
export function prepareStepWorktree(stepId: number): Item {
  let sub = getItem(stepId);
  const task = getTask(sub.task_id);
  const repo = stepRepo(sub);
  ensureTaskWorktree(task, repo);
  const branch = stepBranch(sub);
  const baseRef = sub.base_ref ?? computeBaseRef(sub);
  const dir = ensureWorktree(repo, path.join(worktreeRoot(repo), sub.key), branch, baseRef);
  sub = setItemFields(sub.id, { branch, worktree_path: dir, base_ref: baseRef });
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

export interface StepDiff {
  repo: string;
  base: string;
  baseRef: string;
  diff: string;
  commits: string;
  needsRebase: boolean;
  uncommitted: boolean;
}

export function stepDiff(sub: Item): StepDiff {
  const empty = { repo: sub.repo ?? "", base: "", baseRef: sub.base_ref ?? "", diff: "", commits: "", needsRebase: false, uncommitted: false };
  if (sub.repo_id == null) return empty;
  const repo = stepRepo(sub);
  if (!sub.worktree_path || !fs.existsSync(sub.worktree_path) || !sub.base_ref) {
    // po done worktree jest usunięty — diff z commita merge'a w gałęzi zadania
    const task = getTask(sub.task_id);
    const tb = taskBranch(task);
    if (sub.branch && isGitRepo(repo.path) && branchExists(repo.path, sub.branch) && branchExists(repo.path, tb)) {
      const tip = git(repo.path, ["rev-parse", sub.branch]);
      const merge = git(repo.path, ["log", "--merges", "--format=%H %P", tb], { allowFail: true })
        .split("\n")
        .map((l) => l.split(" "))
        .find((parts) => parts[2] === tip);
      if (merge) {
        const [m, p1] = merge;
        return {
          ...empty,
          base: p1,
          baseRef: tb,
          diff: git(repo.path, ["diff", "--no-color", "-M", p1, m]),
          commits: git(repo.path, ["log", "--oneline", `${p1}..${tip}`]),
        };
      }
      const base = git(repo.path, ["merge-base", tb, sub.branch], { allowFail: true });
      if (base && base !== tip) {
        return { ...empty, base, baseRef: tb, diff: git(repo.path, ["diff", "--no-color", "-M", base, sub.branch]), commits: git(repo.path, ["log", "--oneline", `${base}..${sub.branch}`]) };
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

/** Rebase Kroku na aktualną bazę. Przy konflikcie wycofuje się i zgłasza błąd. */
export function rebaseStep(stepId: number): Item {
  let sub = getItem(stepId);
  if (!sub.worktree_path) throw new VkError("Krok nie ma worktree");
  // jeśli zależności są już done, baza przechodzi na gałąź zadania
  const newBase = computeBaseRef(sub);
  if (newBase !== sub.base_ref) sub = setItemFields(sub.id, { base_ref: newBase });
  const dir = sub.worktree_path!;
  if (hasChanges(dir)) throw new VkError("Worktree ma niezacommitowane zmiany — najpierw commit");
  const r = spawnSync("git", ["rebase", newBase], { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) {
    spawnSync("git", ["rebase", "--abort"], { cwd: dir });
    throw new VkError(`Konflikt podczas rebase na ${newBase}. Rozwiąż go w sesji pracy nad Krokiem ${sub.key}.\n${r.stdout}${r.stderr}`);
  }
  return sub;
}

/**
 * Akceptacja Kroku: commit ewentualnych zmian, merge --no-ff do gałęzi zadania w repo Kroku,
 * usunięcie worktree Kroku (gałąź zostaje), przełączenie zależnych Kroków na gałąź zadania.
 */
export function mergeStep(stepId: number): Item {
  let sub = getItem(stepId);
  const task = getTask(sub.task_id);
  const repo = stepRepo(sub);
  if (!sub.branch || !branchExists(repo.path, sub.branch)) throw new VkError("Krok nie ma gałęzi do scalenia");
  if (sub.worktree_path && fs.existsSync(sub.worktree_path)) {
    commitAll(sub.worktree_path, `${sub.key}: poprawki z review`);
  }
  const items = listItems(task.id);
  const notDoneDeps = effectiveDeps(items, items.find((i) => i.id === sub.id)!).filter((s) => s.status !== "done");
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
  sub = setItemFields(sub.id, { status: "done", worktree_path: null, error: "" });
  // Kroki, które bazowały na tym Kroku, przechodzą (gdy to możliwe) na gałąź zadania
  for (const s of listSteps(task.id)) {
    if (s.id === sub.id || !s.base_ref || s.status === "done") continue;
    if (s.base_ref === sub.branch) setItemFields(s.id, { base_ref: computeBaseRef(s) });
  }
  return sub;
}

export function removeStepWorktree(step: Item) {
  if (step.repo_id == null || !step.worktree_path || !fs.existsSync(step.worktree_path)) return;
  git(stepRepo(step).path, ["worktree", "remove", "--force", step.worktree_path], { allowFail: true });
}

/** Klonuje (płytko) repozytorium zasobu do cache, jeśli jeszcze go nie ma. */
export function ensureGitResource(url: string): string {
  const dir = path.join(subdir("cache"), slug(url.replace(/^(https?:\/\/|git@|ssh:\/\/)/, "")));
  if (!fs.existsSync(path.join(dir, ".git"))) {
    execFileSync("git", ["clone", "--depth", "1", url, dir], { stdio: ["ignore", 2, 2] });
  }
  return dir;
}
