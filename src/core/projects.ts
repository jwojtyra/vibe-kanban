import path from "node:path";
import { currentBranch, isGitRepo } from "./git.js";
import { createProject, createRepo, findProject, getProject, listRepos, listTasks, type Project, type Repo, VkError } from "./repo.js";

export interface RepoInput {
  path: string;
  name?: string;
  base_branch?: string;
  description?: string;
}

export function expandPath(p: string): string {
  return path.resolve(String(p ?? "").trim().replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
}

/** Dodaje lokalne repozytorium git do projektu (walidacja ścieżki, domyślnie bieżąca gałąź). */
export function addRepo(projectId: number, input: RepoInput): Repo {
  const repoPath = expandPath(input.path);
  if (!isGitRepo(repoPath)) {
    const inDocker = process.env.VK_BIND === "0.0.0.0";
    throw new VkError(
      `${repoPath} nie jest repozytorium git` +
        (inDocker ? " (albo nie leży w katalogu projektów zamontowanym w kontenerze — patrz scripts/docker-setup.sh)" : ""),
    );
  }
  return createRepo({
    project_id: projectId,
    name: input.name,
    path: repoPath,
    base_branch: input.base_branch?.trim() || currentBranch(repoPath),
    description: input.description,
  });
}

/** Tworzy projekt razem z repozytoriami (wszystko albo nic). */
export function createProjectWithRepos(data: { name: string; description?: string; assumptions?: string; repos?: RepoInput[] }) {
  const repos = data.repos ?? [];
  for (const r of repos) {
    const p = expandPath(r.path);
    if (!isGitRepo(p)) throw new VkError(`${p} nie jest repozytorium git`);
  }
  const project = createProject(data);
  for (const r of repos) addRepo(project.id, r);
  return projectView(project);
}

export function projectView(p: Project) {
  return { ...p, repos: listRepos(p.id) };
}

export function projectSummary(ref: string | number) {
  const p = findProject(ref);
  return {
    ...projectView(getProject(p.id)),
    tasks: listTasks(p.id).map((t) => ({ key: t.key, title: t.title, status: t.status })),
  };
}
