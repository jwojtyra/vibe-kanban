import fs from "node:fs";
import path from "node:path";
import { ensureGitResource, taskBranch, taskWorktreePath } from "./git.js";
import { slug, subdir } from "./paths.js";
import {
  childrenOf,
  derivedStatus,
  effectiveResources,
  getRepo,
  getSettings,
  LEVEL,
  LEVEL_NAME,
  listComments,
  listItems,
  listTaskRepos,
  type Comment,
  type Item,
  type Task,
} from "./repo.js";

export interface ResolvedResource {
  name: string;
  scope: string;
  kind: string;
  location: string;
  local_path: string | null;
  note: string;
}

export function gitCacheDir(url: string) {
  return path.join(subdir("cache"), slug(url.replace(/^(https?:\/\/|git@|ssh:\/\/)/, "")));
}

/**
 * Zasoby zadania z rozwiązanymi ścieżkami lokalnymi.
 *  - true: klonuje brakujące repozytoria git (CLI na hoście),
 *  - "defer": zwraca docelowe ścieżki bez sprawdzania — klonowanie wykona skrypt na hoście,
 *  - false: tylko to, co już istnieje (widok w MCP/UI).
 */
export function resolveResources(task: Task, clone: boolean | "defer"): ResolvedResource[] {
  return effectiveResources(task).map((r) => {
    let local: string | null = null;
    if (clone === "defer") {
      local = r.kind === "git" ? gitCacheDir(r.location) : path.resolve(r.location.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
      return { name: r.name, scope: r.scope, kind: r.kind, location: r.location, local_path: local, note: r.note };
    }
    if (r.kind === "git") {
      const cached = gitCacheDir(r.location);
      if (clone) {
        try {
          local = ensureGitResource(r.location);
        } catch (e) {
          process.stderr.write(`[vk] Nie udało się sklonować ${r.location}: ${(e as Error).message}\n`);
        }
      } else if (fs.existsSync(cached)) local = cached;
    } else {
      local = path.resolve(r.location.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
      if (!fs.existsSync(local)) local = null;
    }
    return { name: r.name, scope: r.scope, kind: r.kind, location: r.location, local_path: local, note: r.note };
  });
}

// ---------- widoki dla MCP ----------

export function reposContext(task: Task) {
  return listTaskRepos(task.id).map((r) => ({
    name: r.name,
    path: r.path,
    base_branch: r.base_branch,
    test_command: r.test_command || undefined,
    description: r.description || undefined,
    task_worktree: taskWorktreePath(task, r),
  }));
}

/** Zwięzły widok elementu planu. */
export function itemSummary(items: Item[], i: Item) {
  return {
    key: i.key,
    type: LEVEL_NAME[i.level],
    title: i.title,
    status: derivedStatus(items, i),
    ...(i.level === LEVEL.STEP ? { repo: i.repo, kind: i.kind } : {}),
    depends_on: i.depends_on.length ? i.depends_on : undefined,
    description: i.description || undefined,
    problem: i.problem || undefined,
    [i.level === LEVEL.FEATURE ? "acceptance_tests" : "acceptance"]: i.acceptance || undefined,
    summary: i.summary || undefined,
  };
}

type TreeNode = ReturnType<typeof itemSummary> & { children?: TreeNode[] };

/** Plan w postaci drzewa Etap → Funkcja → Krok. */
export function planTree(task: Task): TreeNode[] {
  const items = listItems(task.id);
  const node = (i: Item): TreeNode => {
    const ch = childrenOf(items, i.id);
    return { ...itemSummary(items, i), ...(ch.length ? { children: ch.map(node) } : {}) };
  };
  return childrenOf(items, null).map(node);
}

export function taskContext(task: Task) {
  return {
    key: task.key,
    title: task.title,
    description: task.description,
    ticket: task.ticket_url ? { id: task.ticket_id, url: task.ticket_url } : null,
    links: task.links,
    assumptions: { global: getSettings().assumptions || undefined, task: task.assumptions || undefined },
    repositories: reposContext(task),
    task_branch: taskBranch(task),
    resources_readonly: resolveResources(task, false),
    status: task.status,
    plan: planTree(task),
  };
}

/** Szczegóły elementu: z rodzicami (Funkcja, Etap), dziećmi i komentarzami. */
export function itemContext(item: Item) {
  const items = listItems(item.task_id);
  const parents: ReturnType<typeof itemSummary>[] = [];
  let p = item.parent_id ? items.find((i) => i.id === item.parent_id) : undefined;
  while (p) {
    parents.push(itemSummary(items, p));
    const pid = p.parent_id;
    p = pid ? items.find((i) => i.id === pid) : undefined;
  }
  return {
    ...itemSummary(items, item),
    parents,
    children: childrenOf(items, item.id).map((c) => itemSummary(items, c)),
    ...(item.level === LEVEL.STEP
      ? {
          branch: item.branch,
          worktree_path: item.worktree_path,
          base_ref: item.base_ref,
          test_command: item.repo_id ? getRepo(item.repo_id).test_command || undefined : undefined,
          error: item.error || undefined,
          review_comments: listComments(item.id, true).map(commentView),
        }
      : {}),
  };
}

export function commentView(c: Comment) {
  return {
    id: c.id,
    file: c.file,
    line: c.line,
    side: c.side,
    line_text: c.line_text,
    body: c.body,
    resolved: !!c.resolved,
    resolution: c.resolution || undefined,
  };
}

// ---------- prompty ----------

export type PromptKind = "plan" | "impl" | "review";

export function promptTemplate(task: Task, kind: PromptKind): string {
  const own = kind === "plan" ? task.plan_prompt : kind === "impl" ? task.impl_prompt : task.review_prompt;
  return own ?? getSettings()[`${kind}_prompt`];
}

function linksText(task: Task) {
  return task.links.map((l) => `- ${l.url}${l.note ? ` — ${l.note}` : ""}`).join("\n") || "(brak)";
}

function reposText(task: Task) {
  return (
    listTaskRepos(task.id)
      .map(
        (r) =>
          `- ${r.name}: ${r.path} (baza ${r.base_branch}${r.test_command ? `, testy: ${r.test_command}` : ""})${r.description ? ` — ${r.description}` : ""}`,
      )
      .join("\n") || "(brak — dołącz repozytoria do ticketu)"
  );
}

function resourcesText(res: ResolvedResource[]) {
  return (
    res
      .map((r) => `- ${r.name} [${r.scope}] ${r.local_path ?? r.location}${r.local_path ? "" : " (niedostępne lokalnie)"}${r.note ? ` — ${r.note}` : ""}`)
      .join("\n") || "(brak)"
  );
}

function commentsText(comments: Comment[]) {
  return (
    comments
      .filter((c) => !c.resolved)
      .map((c) => `- #${c.id} ${c.file ? `${c.file}${c.line ? `:${c.line}` : ""}` : "(ogólny)"}: ${c.body}`)
      .join("\n") || "(brak otwartych komentarzy)"
  );
}

export function renderPrompt(tpl: string, task: Task, step?: Item, res?: ResolvedResource[]): string {
  const vars: Record<string, string> = {
    "task.key": task.key,
    "task.title": task.title,
    "task.description": task.description || "(brak)",
    "task.ticket_id": task.ticket_id || "(brak)",
    "task.ticket_url": task.ticket_url || "(brak)",
    "task.assumptions": task.assumptions || "(brak)",
    "task.links": linksText(task),
    assumptions: getSettings().assumptions || "(brak)",
    repos: reposText(task),
    resources: resourcesText(res ?? resolveResources(task, false)),
  };
  if (step) {
    const items = listItems(task.id);
    const feature = items.find((i) => i.id === step.parent_id);
    const stage = feature ? items.find((i) => i.id === feature.parent_id) : undefined;
    const testCmd = step.repo_id ? getRepo(step.repo_id).test_command : "";
    Object.assign(vars, {
      "step.key": step.key,
      "step.title": step.title,
      "step.kind": step.kind === "test" ? "test — testy akceptacyjne (czerwone)" : "impl — implementacja",
      "step.description": step.description || "(brak)",
      "step.acceptance": step.acceptance || "(brak)",
      "step.repo": step.repo ?? "(brak)",
      "step.test_command": testCmd || "(nie ustawiono — znajdź właściwą komendę w repozytorium)",
      "feature.key": feature?.key ?? "",
      "feature.title": feature?.title ?? "",
      "feature.description": feature?.description || "(brak)",
      "feature.problem": feature?.problem || "(brak)",
      "feature.acceptance": feature?.acceptance || "(brak)",
      "stage.key": stage?.key ?? "",
      "stage.title": stage?.title ?? "",
      comments: commentsText(listComments(step.id, false)),
    });
  }
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}

/** Tekst dołączany do system promptu każdej sesji (--append-system-prompt). */
export function sessionSystemPrompt(kind: PromptKind, task: Task, res: ResolvedResource[], step?: Item): string {
  const role =
    kind === "plan"
      ? "To jest sesja PLANOWANIA ticketu. Analizujesz i rozbijasz go na plan: Etapy → Funkcje → Kroki. Nie implementujesz kodu."
      : kind === "impl"
        ? `To jest sesja IMPLEMENTACJI Kroku ${step?.key} uruchomiona automatycznie (subagent). Pracujesz w worktree Kroku.`
        : `To jest sesja pracy nad Krokiem ${step?.key} (review / poprawki) w jego worktree.`;
  const globalAssumptions = getSettings().assumptions;
  return [
    "# vibe-kanban",
    role,
    `Ticket: ${task.key} — ${task.title}`,
    task.ticket_url ? `Link: ${task.ticket_id} (${task.ticket_url})` : "",
    step ? `Krok: ${step.key} — ${step.title}; repozytorium ${step.repo}; gałąź ${step.branch}; baza ${step.base_ref}` : "",
    "Masz serwer MCP `vibe-kanban` (narzędzia vk_*) z pełnym kontekstem ticketu, planu i komentarzy z review.",
    "## Poziomy planu",
    "1. Etap — gruby klocek do dalszego podziału. 2. Funkcja — dowozi zmianę funkcjonalną (API lub zachowanie) i ma testy akceptacyjne dowodzące, że działa. 3. Krok — najmniejszy klocek, w jednym repo, wykonywany i recenzowany osobno. Preferowane test-first: Krok z testami (czerwone), potem Kroki, które je zazieleniają.",
    "## Repozytoria ticketu",
    kind === "plan"
      ? "Każdy Krok dotyczy JEDNEGO repo (parametr repo w vk_create_step). Funkcja może mieć Kroki w kilku repo."
      : `Pracujesz w repozytorium ${step?.repo}. Pozostałe repozytoria ticketu są dostępne TYLKO DO ODCZYTU.`,
    reposText(task),
    "## Założenia globalne",
    globalAssumptions || "(brak)",
    "## Założenia ticketu",
    task.assumptions || "(brak)",
    "## Linki do wykorzystania",
    linksText(task),
    "## Zasoby referencyjne — TYLKO DO ODCZYTU",
    "Możesz je czytać i wzorować się na nich. Nigdy ich nie modyfikuj.",
    resourcesText(res),
    "## Zasady",
    "- Wszystko dzieje się lokalnie: nie wykonuj `git push`, nie twórz pull requestów, nie publikuj niczego.",
  ]
    .filter((l) => l !== "")
    .join("\n")
    .replace(/\n(#+ )/g, "\n\n$1");
}

// ---------- uruchamianie claude ----------

/**
 * Konfiguracja MCP dla sesji. Gdy serwer działa w Dockerze (VK_CONTAINER), sesja na hoście
 * uruchamia MCP w kontenerze przez `docker exec -i` — na hoście nie trzeba Node ani `vk`.
 */
export function mcpConfig(cli: string, taskKey: string, itemKey?: string): string {
  const vkArgs = ["mcp", "--task", taskKey, ...(itemKey ? ["--item", itemKey] : [])];
  const container = process.env.VK_CONTAINER;
  if (container) {
    return JSON.stringify({
      mcpServers: { "vibe-kanban": { command: "docker", args: ["exec", "-i", container, "node", "--no-warnings", cli, ...vkArgs] } },
    });
  }
  const env: Record<string, string> = {};
  if (process.env.VK_HOME) env.VK_HOME = process.env.VK_HOME;
  return JSON.stringify({ mcpServers: { "vibe-kanban": { command: process.execPath, args: ["--no-warnings", cli, ...vkArgs], env } } });
}

/** Ustawienia z regułami deny dla ścieżek tylko do odczytu. */
export function readonlySettings(paths: string[]): string {
  const deny: string[] = [];
  for (const lp of paths) {
    const p = `/${lp.replace(/\/+$/, "")}/**`; // "//abs/path/**" = ścieżka absolutna
    deny.push(`Edit(${p})`, `Write(${p})`, `NotebookEdit(${p})`);
  }
  return JSON.stringify({ permissions: { deny } });
}
