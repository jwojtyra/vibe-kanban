import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { commentView, subtaskContext, subtaskSummary, taskContext } from "../core/context.js";
import { commitAll } from "../core/git.js";
import {
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

const depsSchema = z
  .array(z.union([z.string(), z.number()]))
  .optional()
  .describe("Zależności: klucze (np. PROJ-1-2) lub numery podzadań, które muszą być zrobione wcześniej");

/**
 * Serwer MCP ograniczony do jednego zadania (i opcjonalnie podzadania).
 * Uruchamiany przez sesje Claude Code: vk mcp --task KEY [--subtask KEY]
 */
export async function startMcpServer(taskKey: string, subtaskKey?: string) {
  const task0 = getTaskByKey(taskKey);
  const taskId = task0.id;
  const defaultSub = subtaskKey ? resolveSubtaskRef(taskId, subtaskKey) : undefined;

  const sub = (ref?: string | number): Subtask => {
    if (ref !== undefined && ref !== "") return resolveSubtaskRef(taskId, ref);
    if (defaultSub) return resolveSubtaskRef(taskId, defaultSub.key);
    throw new VkError("Podaj klucz podzadania");
  };

  const server = new McpServer({ name: "vibe-kanban", version: "0.1.0" });

  const wrap =
    <A>(fn: (a: A) => unknown) =>
    async (a: A) => {
      try {
        return ok(await fn(a));
      } catch (e) {
        return fail(e);
      }
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
        title: z.string().describe("Krótki tytuł"),
        description: z.string().describe("Co dokładnie zrobić"),
        problem: z.string().describe("Jaki problem rozwiązuje to podzadanie"),
        acceptance_criteria: z.string().optional().describe("Kryteria akceptacji (lista)"),
        position: z.number().int().positive().optional().describe("Pozycja w kolejności (1 = pierwsze); domyślnie na końcu"),
        depends_on: depsSchema,
      },
    },
    wrap((a: { title: string; description: string; problem: string; acceptance_criteria?: string; position?: number; depends_on?: (string | number)[] }) =>
      subtaskSummary(
        createSubtask(taskId, {
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
        title: z.string().optional(),
        description: z.string().optional(),
        problem: z.string().optional(),
        acceptance_criteria: z.string().optional(),
        position: z.number().int().positive().optional(),
        depends_on: depsSchema,
      },
    },
    wrap((a: { key: string; title?: string; description?: string; problem?: string; acceptance_criteria?: string; position?: number; depends_on?: (string | number)[] }) => {
      const s = sub(a.key);
      if (!["draft", "todo"].includes(s.status)) throw new VkError(`Podzadanie ${s.key} ma status ${s.status} — edycja tylko w Draft/Todo`);
      return subtaskSummary(
        updateSubtask(s.id, {
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

  await server.connect(new StdioServerTransport());
}
