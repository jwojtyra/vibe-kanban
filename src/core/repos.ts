import path from "node:path";
import { currentBranch, isGitRepo } from "./git.js";
import { createRepo, type Repo, VkError } from "./repo.js";

export interface RepoInput {
  path: string;
  name?: string;
  base_branch?: string;
  test_command?: string;
  description?: string;
}

export function expandPath(p: string): string {
  return path.resolve(String(p ?? "").trim().replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
}

/** Dodaje lokalne repozytorium git do globalnej listy (walidacja ścieżki, domyślnie bieżąca gałąź). */
export function addRepo(input: RepoInput): Repo {
  const repoPath = expandPath(input.path);
  if (!isGitRepo(repoPath)) {
    const inDocker = process.env.VK_BIND === "0.0.0.0";
    throw new VkError(
      `${repoPath} nie jest repozytorium git` +
        (inDocker ? " (albo nie leży w katalogu zamontowanym w kontenerze — patrz scripts/docker-setup.sh)" : ""),
    );
  }
  return createRepo({
    name: input.name,
    path: repoPath,
    base_branch: input.base_branch?.trim() || currentBranch(repoPath),
    test_command: input.test_command,
    description: input.description,
  });
}
