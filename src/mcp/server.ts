import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { commentView, subtaskContext, subtaskSummary, taskContext } from "../core/context.js";
import { commitAll } from "../core/git.js";
import { addRepo, createProjectWithRepos, projectSummary, projectView } from "../core/projects.js";
import {
  createTask,
  findProject,
  getSettings,
  listProjects,
  updateProject,
  createSubtask,
  deleteSubtask,
  getTask,
  getTaskByKey,
  listComments,
  listSubtasks,
  reorderSubtasks,
  resolveSubtaskRef,
  runnableSubtasks,
  setSubtaskFields,
  updateComment,
  updateSubtask,
  type Subtask,
  VkError,
} from "../core/repo.js";

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

function fail(e: unknown) {
  return { content: [{ type: "text" as const, text: `Błąd: ${(e as Error).message}` }], isError: true };
}

const wrap =
  <A>(fn: (a: A) => unknown) =>
  async (a: A) => {
    try {
      return ok(await fn(a));
    } catch (e) {
      return fail(e);
    }
  };

const depsSchema = z
  .array(z.union([z.string(), z.number()]))
  .optional()
  .describe("Zależności: klucze (np. PROJ-1-2) lub numery podzadań, które muszą być zrobione wcześniej");

/**
 * Serwer MCP ograniczony do jednego zadania (i opcjonalnie podzadania).
 * Uruchamiany przez sesje Claude Code: vk mcp --task KEY [--subtask KEY]
 */
export async function startMcpServer(taskKey?: string, subtaskKey?: string) {
  const server = new McpServer({ name: "vibe-kanban", version: "0.2.0" });
  const task0 = taskKey ? getTaskByKey(taskKey) : undefined;
  registerAdminTools(server, task0?.project_id);
  if (task0) registerTaskTools(server, task0.id, subtaskKey);
  await server.connect(new StdioServerTransport());
}

const repoInput = z.object({
  path: z.string().describe("Ścieżka do lokalnego repozytorium git"),
  name: z.string().optional().describe("Krótka nazwa, np. frontend / backend (domyślnie nazwa katalogu)"),
  base_branch: z.string().optional().describe("Gałąź bazowa (domyślnie bieżąca gałąź repo)"),
  description: z.string().optional().describe("Czego dotyczy repo (pomaga agentom przydzielać podzadania)"),
});

/** Narzędzia do zarządzania projektami, repozytoriami i zadaniami (dostępne w każdej sesji). */
function registerAdminTools(server: McpServer, defaultProjectId?: number) {
  const project = (ref?: string | number) => {
    if (ref !== undefined && ref !== "") return findProject(ref);
    if (defaultProjectId !== undefined) return findProject(defaultProjectId);
    throw new VkError("Podaj projekt (nazwa lub ID)");
  };

  server.registerTool(
    "vk_list_projects",
    { description: "Lista projektów vibe-kanban z ich repozytoriami.", inputSchema: {} },
    wrap(() => listProjects().map(projectView)),
  );

  server.registerTool(
    "vk_get_project",
    {
      description: "Projekt: repozytoria, założenia i lista zadań. Bez parametru — projekt bieżącego zadania.",
      inputSchema: { project: z.string().optional().describe("Nazwa lub ID projektu") },
    },
    wrap(({ project: p }: { project?: string }) => projectSummary(project(p).id)),
  );

  server.registerTool(
    "vk_create_project",
    {
      description:
        "Tworzy projekt grupujący jedno lub więcej lokalnych repozytoriów (np. frontend i backend). Jedno zadanie/ticket może obejmować zmiany we wszystkich repo projektu.",
      inputSchema: {
        name: z.string().describe("Unikalna nazwa projektu"),
        description: z.string().optional(),
        assumptions: z.string().optional().describe("Założenia projektu przekazywane do każdej sesji"),
        repos: z.array(repoInput).optional().describe("Repozytoria projektu"),
      },
    },
    wrap((a: { name: string; description?: string; assumptions?: string; repos?: z.infer<typeof repoInput>[] }) => createProjectWithRepos(a)),
  );

  server.registerTool(
    "vk_add_repo",
    {
      description: "Dodaje lokalne repozytorium git do projektu. Bez parametru project — do projektu bieżącego zadania.",
      inputSchema: { project: z.string().optional().describe("Nazwa lub ID projektu"), ...repoInput.shape },
    },
    wrap((a: { project?: string } & z.infer<typeof repoInput>) => addRepo(project(a.project).id, a)),
  );

  server.registerTool(
    "vk_update_project",
    {
      description: "Aktualizuje opis lub założenia projektu.",
      inputSchema: { project: z.string().optional(), description: z.string().optional(), assumptions: z.string().optional() },
    },
    wrap((a: { project?: string; description?: string; assumptions?: string }) =>
      projectView(updateProject(project(a.project).id, { description: a.description, assumptions: a.assumptions })),
    ),
  );

  server.registerTool(
    "vk_create_task",
    {
      description:
        "Tworzy zadanie (ticket) w projekcie. Z linku do ticketu (np. Jira) wyciągany jest klucz zadania. Zwraca polecenie do rozpoczęcia planowania.",
      inputSchema: {
        project: z.string().optional().describe("Nazwa lub ID projektu"),
        title: z.string(),
        ticket_url: z.string().optional(),
        description: z.string().optional(),
        assumptions: z.string().optional(),
        links: z.array(z.object({ url: z.string(), note: z.string().optional() })).optional(),
      },
    },
    wrap((a: { project?: string; title: string; ticket_url?: string; description?: string; assumptions?: string; links?: { url: string; note?: string }[] }) => {
      const t = createTask({ ...a, project_id: project(a.project).id });
      const cli = getSettings().cli_command || "vk";
      return { key: t.key, title: t.title, ticket_id: t.ticket_id || undefined, plan_command: `${cli} plan ${t.key}` };
    }),
  );
}

/** Narzędzia ograniczone do jednego zadania (i opcjonalnie podzadania). */
function registerTaskTools(server: McpServer, taskId: number, subtaskKey?: string) {
  const defaultSub = subtaskKey ? resolveSubtaskRef(taskId, subtaskKey) : undefined;

  const sub = (ref?: string | number): Subtask => {
    if (ref !== undefined && ref !== "") return resolveSubtaskRef(taskId, ref);
    if (defaultSub) return resolveSubtaskRef(taskId, defaultSub.key);
    throw new VkError("Podaj klucz podzadania");
  };


  server.registerTool(
    "vk_get_task",
    {
      description:
        "Pełny kontekst zadania głównego: opis, ticket, linki, założenia (projektu i zadania), zasoby referencyjne (tylko do odczytu), lista podzadań ze statusami i zależnościami.",
      inputSchema: {},
    },
    wrap(() => taskContext(getTask(taskId))),
  );

  server.registerTool(
    "vk_list_subtasks",
    { description: "Lista podzadań w kolejności, ze statusami i zależnościami.", inputSchema: {} },
    wrap(() => listSubtasks(taskId).map(subtaskSummary)),
  );

  server.registerTool(
    "vk_get_subtask",
    {
      description: "Szczegóły podzadania: opis, problem, kryteria, gałąź, worktree, komentarze z review. Bez klucza — bieżące podzadanie sesji.",
      inputSchema: { key: z.string().optional().describe("Klucz lub numer podzadania") },
    },
    wrap(({ key }: { key?: string }) => subtaskContext(sub(key))),
  );

  server.registerTool(
    "vk_create_subtask",
    {
      description:
        "Tworzy podzadanie (status Draft — wymaga akceptacji człowieka w UI). Używaj w sesji planowania po uzgodnieniu planu.",
      inputSchema: {
        repo: z.string().optional().describe("Repozytorium projektu, którego dotyczy podzadanie (wymagane, gdy projekt ma kilka repo)"),
        title: z.string().describe("Krótki tytuł"),
        description: z.string().describe("Co dokładnie zrobić"),
        problem: z.string().describe("Jaki problem rozwiązuje to podzadanie"),
        acceptance_criteria: z.string().optional().describe("Kryteria akceptacji (lista)"),
        position: z.number().int().positive().optional().describe("Pozycja w kolejności (1 = pierwsze); domyślnie na końcu"),
        depends_on: depsSchema,
      },
    },
    wrap((a: { repo?: string; title: string; description: string; problem: string; acceptance_criteria?: string; position?: number; depends_on?: (string | number)[] }) =>
      subtaskSummary(
        createSubtask(taskId, {
          repo: a.repo,
          title: a.title,
          description: a.description,
          problem: a.problem,
          acceptance: a.acceptance_criteria,
          position: a.position,
          depends_on: a.depends_on,
        }),
      ),
    ),
  );

  server.registerTool(
    "vk_update_subtask",
    {
      description: "Aktualizuje podzadanie w statusie Draft lub Todo (pola, pozycję, zależności).",
      inputSchema: {
        key: z.string().describe("Klucz lub numer podzadania"),
        repo: z.string().optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        problem: z.string().optional(),
        acceptance_criteria: z.string().optional(),
        position: z.number().int().positive().optional(),
        depends_on: depsSchema,
      },
    },
    wrap((a: { key: string; repo?: string; title?: string; description?: string; problem?: string; acceptance_criteria?: string; position?: number; depends_on?: (string | number)[] }) => {
      const s = sub(a.key);
      if (!["draft", "todo"].includes(s.status)) throw new VkError(`Podzadanie ${s.key} ma status ${s.status} — edycja tylko w Draft/Todo`);
      return subtaskSummary(
        updateSubtask(s.id, {
          repo: a.repo,
          title: a.title,
          description: a.description,
          problem: a.problem,
          acceptance: a.acceptance_criteria,
          position: a.position,
          depends_on: a.depends_on,
        }),
      );
    }),
  );

  server.registerTool(
    "vk_delete_subtask",
    { description: "Usuwa podzadanie w statusie Draft.", inputSchema: { key: z.string() } },
    wrap(({ key }: { key: string }) => {
      const s = sub(key);
      if (s.status !== "draft") throw new VkError("Usuwać można tylko podzadania w Draft");
      deleteSubtask(s.id);
      return `Usunięto ${s.key}`;
    }),
  );

  server.registerTool(
    "vk_reorder_subtasks",
    {
      description: "Ustala kolejność podzadań (lista kluczy/numerów od pierwszego). Niewymienione trafiają na koniec.",
      inputSchema: { order: z.array(z.union([z.string(), z.number()])) },
    },
    wrap(({ order }: { order: (string | number)[] }) => {
      reorderSubtasks(taskId, order);
      return listSubtasks(taskId).map((s) => `${s.position}. ${s.key} ${s.title}`).join("\n");
    }),
  );

  server.registerTool(
    "vk_next_subtasks",
    { description: "Podzadania gotowe do realizacji (Todo, zależności w Review/Done).", inputSchema: {} },
    wrap(() => runnableSubtasks(taskId).map(subtaskSummary)),
  );

  server.registerTool(
    "vk_list_comments",
    {
      description: "Komentarze z review dla podzadania (plik, linia, treść). Bez klucza — bieżące podzadanie.",
      inputSchema: { key: z.string().optional(), include_resolved: z.boolean().optional() },
    },
    wrap(({ key, include_resolved }: { key?: string; include_resolved?: boolean }) =>
      listComments(sub(key).id, include_resolved ?? false).map(commentView),
    ),
  );

  server.registerTool(
    "vk_resolve_comment",
    {
      description: "Oznacza komentarz z review jako rozwiązany, z krótkim opisem co zrobiono.",
      inputSchema: { id: z.number().int(), resolution: z.string() },
    },
    wrap(({ id, resolution }: { id: number; resolution: string }) => commentView(updateComment(id, { resolved: true, resolution }))),
  );

  server.registerTool(
    "vk_submit_for_review",
    {
      description:
        "Kończy implementację podzadania: commituje pozostałe zmiany w worktree i przenosi podzadanie do Review. Wywołaj na końcu pracy.",
      inputSchema: { key: z.string().optional(), summary: z.string().describe("Krótkie podsumowanie zmian dla recenzenta") },
    },
    wrap(({ key, summary }: { key?: string; summary: string }) => {
      const s = sub(key);
      if (!s.worktree_path) throw new VkError("Podzadanie nie ma worktree");
      const committed = commitAll(s.worktree_path, `${s.key}: ${s.title}`);
      setSubtaskFields(s.id, { status: "review", summary, error: "" });
      return `${s.key} → Review${committed ? " (zacommitowano pozostałe zmiany)" : ""}`;
    }),
  );
}
