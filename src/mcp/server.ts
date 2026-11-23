import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { attachmentsContext, commentView, guidelinesText, itemContext, itemSummary, questionView, taskContext } from "../core/context.js";
import { commitAll } from "../core/git.js";
import { addRepo } from "../core/repos.js";
import { copyCommand } from "../http/scripts.js";
import {
  attachRepo,
  closeQuestion,
  createQuestion,
  getQuestion,
  listQuestions,
  updateSettings,
  createItem,
  createTask,
  deleteItem,
  derivedStatus,
  findRepo,
  getSettings,
  getTask,
  getTaskByKey,
  LEVEL,
  LEVEL_NAME,
  listComments,
  listItems,
  listRepos,
  listTaskRepos,
  listTasks,
  reorderItems,
  resolveItemRef,
  runnableSteps,
  setItemFields,
  updateComment,
  updateItem,
  updateRepo,
  type Item,
  type ItemInput,
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
  .describe("Zależności: klucze elementów TEGO SAMEGO poziomu (pełne, np. SHOP-1-1.2, albo krótkie, np. 1.2)");

/**
 * Serwer MCP vibe-kanban (stdio).
 *  - bez --task: tryb globalny (repozytoria, tickety),
 *  - z --task: dodatkowo narzędzia planu i realizacji ticketu (opcjonalnie --item = bieżący Krok).
 */
export async function startMcpServer(taskKey?: string, itemKey?: string) {
  const server = new McpServer({ name: "vibe-kanban", version: "0.3.0" });
  registerGlobalTools(server);
  if (taskKey) registerTaskTools(server, getTaskByKey(taskKey).id, itemKey);
  await server.connect(new StdioServerTransport());
}

const repoInput = {
  path: z.string().describe("Ścieżka do lokalnego repozytorium git"),
  name: z.string().optional().describe("Krótka nazwa, np. frontend / backend (domyślnie nazwa katalogu)"),
  base_branch: z.string().optional().describe("Gałąź bazowa (domyślnie bieżąca gałąź repo)"),
  test_command: z.string().optional().describe("Komenda uruchamiająca testy, np. npm test"),
  description: z.string().optional().describe("Czego dotyczy repo"),
};

function registerGlobalTools(server: McpServer) {
  server.registerTool(
    "vk_list_repos",
    { description: "Globalna lista repozytoriów znanych vibe-kanban.", inputSchema: {} },
    wrap(() => listRepos()),
  );

  server.registerTool(
    "vk_add_repo",
    { description: "Dodaje lokalne repozytorium git do globalnej listy (potem można je dołączać do ticketów).", inputSchema: repoInput },
    wrap((a: { path: string; name?: string; base_branch?: string; test_command?: string; description?: string }) => addRepo(a)),
  );

  server.registerTool(
    "vk_update_repo",
    {
      description: "Zmienia gałąź bazową, komendę testów lub opis repozytorium.",
      inputSchema: { repo: z.string().describe("Nazwa repo"), base_branch: z.string().optional(), test_command: z.string().optional(), description: z.string().optional() },
    },
    wrap((a: { repo: string; base_branch?: string; test_command?: string; description?: string }) => updateRepo(findRepo(a.repo).id, a)),
  );

  server.registerTool(
    "vk_get_guidelines",
    { description: "Dokument „Wytyczne” — wymagania techniczne użytkownika (jak pisać kod, co robić, czego nie robić). Obowiązują w każdej pracy.", inputSchema: {} },
    wrap(() => guidelinesText() || "(brak wytycznych)"),
  );

  server.registerTool(
    "vk_add_guideline",
    {
      description:
        "Dopisuje wymaganie do dokumentu „Wytyczne”. Używaj TYLKO, gdy użytkownik wprost prosi o zapisanie zasady (np. „zapisz w wytycznych, że…”).",
      inputSchema: {
        text: z.string().describe("Treść zasady (zwięźle, w trybie rozkazującym)"),
        section: z.string().optional().describe("Nagłówek sekcji, np. Testy, Klasy, API (opcjonalnie)"),
      },
    },
    wrap(({ text, section }: { text: string; section?: string }) => {
      let doc = guidelinesText();
      const line = `- ${text.trim()}`;
      if (section?.trim()) {
        const h = `## ${section.trim()}`;
        const idx = doc.split("\n").findIndex((l) => l.trim().toLowerCase() === h.toLowerCase());
        if (idx >= 0) {
          const lines = doc.split("\n");
          let end = idx + 1;
          while (end < lines.length && !lines[end].startsWith("## ")) end++;
          while (end > idx + 1 && !lines[end - 1].trim()) end--;
          lines.splice(end, 0, line);
          doc = lines.join("\n");
        } else doc = `${doc}${doc ? "\n\n" : ""}${h}\n${line}`;
      } else doc = `${doc}${doc ? "\n" : ""}${line}`;
      updateSettings({ guidelines: doc });
      return "Dopisano do wytycznych.";
    }),
  );

  server.registerTool(
    "vk_list_tasks",
    { description: "Lista ticketów vibe-kanban.", inputSchema: {} },
    wrap(() => listTasks().map((t) => ({ key: t.key, title: t.title, status: t.status, repos: listTaskRepos(t.id).map((r) => r.name) }))),
  );

  server.registerTool(
    "vk_create_task",
    {
      description:
        "Tworzy ticket. Z linku do ticketu (np. Jira) wyciągany jest klucz. repos — nazwy repozytoriów z globalnej listy, których dotyczy ticket. Zwraca polecenie do rozpoczęcia planowania.",
      inputSchema: {
        title: z.string(),
        ticket_url: z.string().optional(),
        description: z.string().optional(),
        assumptions: z.string().optional(),
        links: z.array(z.object({ url: z.string(), note: z.string().optional() })).optional(),
        repos: z.array(z.string()).optional(),
      },
    },
    wrap((a: { title: string; ticket_url?: string; description?: string; assumptions?: string; links?: { url: string; note?: string }[]; repos?: string[] }) => {
      const t = createTask(a);
      return { key: t.key, title: t.title, ticket_id: t.ticket_id || undefined, repos: listTaskRepos(t.id).map((r) => r.name), plan_command: copyCommand("plan", t.key) };
    }),
  );
}

function registerTaskTools(server: McpServer, taskId: number, itemKey?: string) {
  const current = (ref?: string | number): Item => {
    if (ref !== undefined && ref !== "") return resolveItemRef(taskId, ref);
    if (itemKey) return resolveItemRef(taskId, itemKey);
    throw new VkError("Podaj klucz elementu");
  };
  const summary = (i: Item) => itemSummary(listItems(taskId), i);
  const common = {
    title: z.string().describe("Krótki tytuł"),
    description: z.string().describe("Co dokładnie zrobić / co się zmienia"),
    position: z.number().int().positive().optional().describe("Pozycja wśród rodzeństwa (1 = pierwsze); domyślnie na końcu"),
    depends_on: depsSchema,
  };

  server.registerTool(
    "vk_get_task",
    {
      description:
        "Pełny kontekst ticketu: opis, link, linki, założenia, repozytoria (ścieżki, komendy testów), zasoby referencyjne i załączniki (tylko do odczytu) oraz plan jako drzewo Etap → Funkcja → Krok ze statusami.",
      inputSchema: {},
    },
    wrap(() => taskContext(getTask(taskId))),
  );

  server.registerTool(
    "vk_list_attachments",
    {
      description:
        "Załączniki ticketu dodane przez człowieka (np. ZIP ze specyfikacją, zrzuty ekranu, makiety, PDF): ścieżki lokalne, opisy, zawartość rozpakowanych ZIP-ów. Tylko do odczytu — czytaj je narzędziem Read (obrazy też).",
      inputSchema: {},
    },
    wrap(() => attachmentsContext(getTask(taskId))),
  );

  server.registerTool(
    "vk_attach_repo",
    {
      description: "Dołącza repozytorium z globalnej listy do ticketu (gdy brakuje go w ticket.repositories). Nowe repo dodaj najpierw przez vk_add_repo.",
      inputSchema: { repo: z.string().describe("Nazwa lub ścieżka repo") },
    },
    wrap(({ repo }: { repo: string }) => attachRepo(taskId, repo)),
  );

  server.registerTool(
    "vk_get_item",
    {
      description: "Szczegóły elementu planu (Etap/Funkcja/Krok) z rodzicami, dziećmi i — dla Kroku — gałęzią, worktree i komentarzami z review. Bez klucza — bieżący Krok sesji.",
      inputSchema: { key: z.string().optional() },
    },
    wrap(({ key }: { key?: string }) => itemContext(current(key))),
  );

  server.registerTool(
    "vk_create_stage",
    {
      description: "Tworzy ETAP (poziom 1): gruby klocek pracy, dzielony dalej na Funkcje. Status Draft — wymaga akceptacji człowieka.",
      inputSchema: { ...common, problem: z.string().optional().describe("Jaki problem rozwiązuje") },
    },
    wrap((a: { title: string; description: string; problem?: string; position?: number; depends_on?: (string | number)[] }) =>
      summary(createItem(taskId, LEVEL.STAGE, a)),
    ),
  );

  server.registerTool(
    "vk_create_feature",
    {
      description:
        "Tworzy FUNKCJĘ (poziom 2) w Etapie: dowozi jedną zmianę funkcjonalną (API lub zachowanie). Musi mieć testy akceptacyjne dowodzące, że funkcjonalność działa. Może obejmować kilka repo (przez Kroki).",
      inputSchema: {
        stage: z.string().describe("Klucz Etapu-rodzica"),
        ...common,
        problem: z.string().describe("Jaki problem rozwiązuje / jaka zmiana zachowania"),
        acceptance_tests: z.string().describe("Scenariusze testów akceptacyjnych (lista), które po realizacji Funkcji są zielone"),
      },
    },
    wrap((a: { stage: string; title: string; description: string; problem: string; acceptance_tests: string; position?: number; depends_on?: (string | number)[] }) =>
      summary(createItem(taskId, LEVEL.FEATURE, { ...a, parent: a.stage, acceptance: a.acceptance_tests })),
    ),
  );

  server.registerTool(
    "vk_create_step",
    {
      description:
        "Tworzy KROK (poziom 3) w Funkcji: najmniejszy klocek w JEDNYM repozytorium, wykonywany przez subagenta w osobnym worktree i osobno recenzowany. kind='test' — Krok dodający testy akceptacyjne (czerwone); kind='impl' — implementacja zazieleniająca testy.",
      inputSchema: {
        feature: z.string().describe("Klucz Funkcji-rodzica"),
        repo: z.string().optional().describe("Repozytorium Kroku (wymagane, gdy ticket ma kilka repo)"),
        kind: z.enum(["test", "impl"]).optional().describe("test | impl (domyślnie impl)"),
        ...common,
        acceptance: z.string().optional().describe("Kryteria akceptacji Kroku"),
      },
    },
    wrap((a: { feature: string; repo?: string; kind?: "test" | "impl"; title: string; description: string; acceptance?: string; position?: number; depends_on?: (string | number)[] }) =>
      summary(createItem(taskId, LEVEL.STEP, { ...a, parent: a.feature })),
    ),
  );

  server.registerTool(
    "vk_update_item",
    {
      description: "Aktualizuje element planu w statusie Draft lub Todo (pola, pozycję, zależności; Krok — też repo i kind).",
      inputSchema: {
        key: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        problem: z.string().optional(),
        acceptance: z.string().optional().describe("Funkcja: testy akceptacyjne; Krok: kryteria"),
        repo: z.string().optional(),
        kind: z.enum(["test", "impl"]).optional(),
        position: z.number().int().positive().optional(),
        depends_on: depsSchema,
      },
    },
    wrap((a: { key: string } & ItemInput) => {
      const it = current(a.key);
      const st = derivedStatus(listItems(taskId), it);
      if (!["draft", "todo"].includes(st)) throw new VkError(`${it.key} ma status ${st} — edycja tylko w Draft/Todo`);
      return summary(updateItem(it.id, a));
    }),
  );

  server.registerTool(
    "vk_delete_item",
    { description: "Usuwa element planu w Draft (razem z jego dziećmi).", inputSchema: { key: z.string() } },
    wrap(({ key }: { key: string }) => {
      const it = current(key);
      const sub = listItems(taskId).filter((i) => i.key === it.key || i.key.startsWith(`${it.key}.`));
      if (sub.some((i) => i.status !== "draft")) throw new VkError("Usuwać można tylko elementy w Draft (łącznie z dziećmi)");
      deleteItem(it.id);
      return `Usunięto ${it.key}${sub.length > 1 ? ` i ${sub.length - 1} elementów podrzędnych` : ""}`;
    }),
  );

  server.registerTool(
    "vk_reorder_items",
    {
      description: "Ustala kolejność rodzeństwa (klucze elementów o wspólnym rodzicu, od pierwszego).",
      inputSchema: { order: z.array(z.union([z.string(), z.number()])) },
    },
    wrap(({ order }: { order: (string | number)[] }) => {
      reorderItems(taskId, order);
      return listItems(taskId).map((i) => `${"  ".repeat(i.level - 1)}${i.key} ${i.title}`).join("\n");
    }),
  );

  server.registerTool(
    "vk_next_steps",
    { description: "Kroki gotowe do realizacji (Todo, zależności — także Funkcji i Etapów — w Review/Done).", inputSchema: {} },
    wrap(() => runnableSteps(taskId).map(summary)),
  );

  server.registerTool(
    "vk_ask_question",
    {
      description:
        "Zadaje człowiekowi pytanie (pokazywane w UI przy elemencie planu — żółte tło; blokujące — czerwone). Podaj 2–4 propozycje odpowiedzi; człowiek wybierze jedną albo wpisze własną (np. że chce omówić temat na czacie lub ma dodatkowe pytania). Bez klucza — pytanie do całego ticketu.",
      inputSchema: {
        key: z.string().optional().describe("Element planu (Etap/Funkcja/Krok); pomiń dla pytania o cały ticket"),
        question: z.string(),
        options: z.array(z.string()).describe("Proponowane odpowiedzi"),
        blocking: z.boolean().optional().describe("true = bez odpowiedzi elementu nie da się zrealizować (Kroki nie ruszą)"),
      },
    },
    wrap((a: { key?: string; question: string; options: string[]; blocking?: boolean }) => {
      const it = a.key ? current(a.key) : itemKey ? current() : null;
      return questionView(createQuestion(taskId, { item_id: it?.id ?? null, question: a.question, options: a.options, blocking: a.blocking }));
    }),
  );

  server.registerTool(
    "vk_list_questions",
    {
      description: "Pytania do człowieka z odpowiedziami. status: open | answered | closed (domyślnie open i answered). Bez klucza — wszystkie w tickecie.",
      inputSchema: { key: z.string().optional(), status: z.enum(["open", "answered", "closed"]).optional() },
    },
    wrap(({ key, status }: { key?: string; status?: "open" | "answered" | "closed" }) =>
      listQuestions(taskId, { itemId: key ? current(key).id : undefined, status })
        .filter((q) => status || q.status !== "closed")
        .map(questionView),
    ),
  );

  server.registerTool(
    "vk_close_question",
    { description: "Zamyka obsłużone pytanie (np. po uwzględnieniu odpowiedzi w planie), z krótką notatką.", inputSchema: { id: z.number().int(), note: z.string().optional() } },
    wrap(({ id, note }: { id: number; note?: string }) => {
      if (getQuestion(id).task_id !== taskId) throw new VkError("Pytanie z innego ticketu");
      return questionView(closeQuestion(id, note ?? ""));
    }),
  );

  server.registerTool(
    "vk_set_blocker",
    {
      description: "Oznacza element planu jako zablokowany (czerwony w UI; jego Kroki nie ruszą) z podaniem powodu. Pusty reason usuwa bloker.",
      inputSchema: { key: z.string().optional(), reason: z.string() },
    },
    wrap(({ key, reason }: { key?: string; reason: string }) => {
      const it = current(key);
      setItemFields(it.id, { blocker: reason.trim() });
      return reason.trim() ? `${it.key} zablokowany: ${reason.trim()}` : `${it.key} odblokowany`;
    }),
  );

  server.registerTool(
    "vk_list_comments",
    {
      description: "Komentarze z review Kroku (plik, linia, treść). Bez klucza — bieżący Krok.",
      inputSchema: { key: z.string().optional(), include_resolved: z.boolean().optional() },
    },
    wrap(({ key, include_resolved }: { key?: string; include_resolved?: boolean }) => listComments(current(key).id, include_resolved ?? false).map(commentView)),
  );

  server.registerTool(
    "vk_resolve_comment",
    { description: "Oznacza komentarz z review jako rozwiązany, z opisem, co zrobiono.", inputSchema: { id: z.number().int(), resolution: z.string() } },
    wrap(({ id, resolution }: { id: number; resolution: string }) => commentView(updateComment(id, { resolved: true, resolution }))),
  );

  server.registerTool(
    "vk_submit_for_review",
    {
      description: "Kończy Krok: commituje pozostałe zmiany w worktree i przenosi Krok do Review. Wywołaj na końcu pracy.",
      inputSchema: { key: z.string().optional(), summary: z.string().describe("Podsumowanie zmian dla recenzenta, w tym stan testów") },
    },
    wrap(({ key, summary: text }: { key?: string; summary: string }) => {
      const s = current(key);
      if (s.level !== LEVEL.STEP) throw new VkError(`${s.key} to ${LEVEL_NAME[s.level]} — do review trafiają Kroki`);
      if (!s.worktree_path) throw new VkError("Krok nie ma worktree");
      const committed = commitAll(s.worktree_path, `${s.key}: ${s.title}`);
      setItemFields(s.id, { status: "review", summary: text, error: "" });
      return `${s.key} → Review${committed ? " (zacommitowano pozostałe zmiany)" : ""}`;
    }),
  );
}
