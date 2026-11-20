/**
 * Domyślne ustawienia i prompty. Można je zmienić w UI (Ustawienia),
 * a prompty dodatkowo nadpisać per zadanie.
 *
 * Placeholdery: {{task.key}}, {{task.title}}, {{task.description}}, {{task.ticket_id}},
 * {{task.ticket_url}}, {{task.assumptions}}, {{task.links}}, {{assumptions}} (globalne),
 * {{repos}}, {{resources}}, {{step.key}}, {{step.title}}, {{step.kind}}, {{step.description}},
 * {{step.acceptance}}, {{step.repo}}, {{step.test_command}}, {{feature.key}}, {{feature.title}},
 * {{feature.description}}, {{feature.problem}}, {{feature.acceptance}}, {{stage.key}},
 * {{stage.title}}, {{comments}}, {{guidelines}}, {{levels}}, {{level.stage}}, {{level.feature}},
 * {{level.step}}, {{questions}}
 */

export const DEFAULT_PLAN_PROMPT = `Zadanie {{task.key}}: {{task.title}}

Przeanalizuj zadanie i rozbij je na plan w trzech poziomach.

1. Kontekst: vk_get_task (opis, ticket, linki, założenia, repozytoria, zasoby referencyjne).
   Jeśli podano ticket i masz narzędzia Jira/Atlassian — pobierz jego treść.
2. Przeanalizuj kod repozytoriów ticketu i zasoby referencyjne (tylko do odczytu).
3. Gdy coś jest niejasne albo wymaga mojej decyzji — nie zgaduj. Dodaj pytanie narzędziem
   vk_ask_question (przy ticketcie albo przy konkretnym Etapie/Funkcji/Kroku), z 2–4 propozycjami
   odpowiedzi; blocking=true, jeśli bez odpowiedzi nie da się zrealizować elementu. Odpowiadam
   w UI — sprawdzaj odpowiedzi przez vk_list_questions i zamykaj obsłużone (vk_close_question).
   Gdy odpowiedź mówi, że chcę omówić coś na czacie lub mam dodatkowe pytania — zapytaj mnie tutaj.
4. Zaproponuj plan, a po mojej akceptacji zapisz go narzędziami vk_*:

   Poziom 1 — ETAP (vk_create_stage): gruby klocek pracy, służy do podziału na mniejsze części.

   Poziom 2 — FUNKCJA (vk_create_feature): dowozi jedną zmianę funkcjonalną — nowe/zmienione API
   albo zmianę zachowania. Musi mieć testy dowodzące, że funkcjonalność działa:
   w polu acceptance_tests wypisz scenariusze testów akceptacyjnych. Funkcja może obejmować kilka repo.

   Poziom 3 — KROK (vk_create_step): najmniejszy klocek potrzebny do zbudowania Funkcji,
   zawsze w jednym repozytorium, wykonywany przez subagenta w osobnym worktree i osobno recenzowany.

   Preferowane podejście test-first:
   - pierwszy Krok każdej Funkcji (w danym repo) ma kind="test" i dodaje testy akceptacyjne,
     które na tym etapie są CZERWONE,
   - kolejne Kroki (kind="impl") zależą od Kroku z testami i krok po kroku je zazieleniają;
     po ostatnim Kroku Funkcji wszystkie jej testy są zielone.

   Kolejność i zależności (depends_on) ustawiaj na odpowiednim poziomie: Kroki między sobą,
   Funkcje między sobą (np. frontend czeka na API), Etapy między sobą.
Jak definiować poziomy (ogólne prompty poziomów):
{{levels}}

Nie implementuj niczego w tej sesji.`;

export const DEFAULT_IMPL_PROMPT = `Wykonaj Krok {{step.key}}: {{step.title}} ({{step.kind}}) w repozytorium {{step.repo}}.

Funkcja {{feature.key}}: {{feature.title}}
{{feature.description}}
Testy akceptacyjne Funkcji:
{{feature.acceptance}}

Opis Kroku:
{{step.description}}

Kryteria akceptacji Kroku:
{{step.acceptance}}

Zasady:
- Pracujesz w worktree tego Kroku (bieżący katalog). Zmieniaj tylko to repozytorium.
- Kontekst: vk_get_task (ticket, plan), vk_get_item (Funkcja, Etap, ten Krok).
- Jeśli to Krok typu "test": dodaj testy akceptacyjne Funkcji i potwierdź, że są CZERWONE
  (nie implementuj funkcjonalności).
- Jeśli to Krok typu "impl": zrealizuj swoją część i uruchom testy; testy akceptacyjne Funkcji
  mają się zazieleniać w miarę postępu (po ostatnim Kroku — wszystkie zielone).
- Komenda testów repozytorium: {{step.test_command}}
- Trzymaj się założeń. Zasoby referencyjne i inne repozytoria są tylko do odczytu.
- Nie rób git push ani nie twórz PR.
- Jeśli potrzebujesz decyzji człowieka — vk_ask_question z propozycjami odpowiedzi (blocking=true,
  gdy bez niej nie da się dokończyć); opisz to w podsumowaniu.
- Na koniec zrób commit i wywołaj vk_submit_for_review z podsumowaniem (w tym stan testów).`;

export const DEFAULT_REVIEW_PROMPT = `Pracujemy nad Krokiem {{step.key}}: {{step.title}} (etap review).

Pobierz komentarze z review (vk_list_comments) oraz kontekst (vk_get_item, vk_get_task).
Omów ze mną komentarze, wprowadź uzgodnione poprawki, uruchom testy ({{step.test_command}}),
a rozwiązane komentarze oznacz vk_resolve_comment. Po zmianach zrób commit. Nie rób git push.`;

export const DEFAULT_LEVEL_STAGE = `Etap to gruby klocek pracy, który ma sens biznesowy sam w sobie (np. "Filtrowanie zamówień").
- 1–5 Etapów na ticket; Etap dzielimy na Funkcje.
- Etapy porządkuj tak, by wcześniejsze dostarczały fundament dla późniejszych (zależności między Etapami).`;

export const DEFAULT_LEVEL_FEATURE = `Funkcja dowozi JEDNĄ obserwowalną zmianę zachowania albo API.
- Opisz zmianę z perspektywy użytkownika lub klienta API.
- acceptance_tests: konkretne scenariusze (dane wejściowe → oczekiwany wynik), także przypadki brzegowe i błędy.
- Funkcja może obejmować kilka repozytoriów, ale każdy jej Krok dotyczy jednego.`;

export const DEFAULT_LEVEL_STEP = `Krok to najmniejszy spójny diff do review (zwykle < 300 linii), w jednym repozytorium.
- Pierwszy Krok Funkcji w danym repo: kind="test" — testy akceptacyjne, które są CZERWONE.
- Kolejne Kroki kind="impl" zależą od Kroku z testami i krok po kroku je zazieleniają.
- Każdy Krok zostawia repo w stanie, który się kompiluje; testy spoza Funkcji nie mogą się zepsuć.`;

export const DEFAULT_SETTINGS: Record<string, string> = {
  plan_prompt: DEFAULT_PLAN_PROMPT,
  impl_prompt: DEFAULT_IMPL_PROMPT,
  review_prompt: DEFAULT_REVIEW_PROMPT,
  /** Dokument "Wytyczne": wymagania techniczne zbierane na bieżąco — trafia do każdej sesji. */
  guidelines: "",
  /** (starsze) założenia globalne — używane, gdy wytyczne są puste. */
  assumptions: "",
  /** Ogólne prompty poziomów planu: jak definiować Etap, Funkcję i Krok. */
  level_stage: DEFAULT_LEVEL_STAGE,
  level_feature: DEFAULT_LEVEL_FEATURE,
  level_step: DEFAULT_LEVEL_STEP,
  /**
   * Polecenie CLI do copy-paste (np. "vk" po npm link). Puste = polecenia `bash <(curl …)`
   * generowane przez serwer — nic nie trzeba instalować poza Claude Code, docker i curl.
   */
  cli_command: "",
  /** Polecenie uruchamiające Claude Code. */
  claude_command: "claude",
  /** Tryb uprawnień subagenta (vk run / vk exec): default | acceptEdits | bypassPermissions. */
  exec_permission_mode: "acceptEdits",
  /** Dodatkowo dozwolone narzędzia subagenta (oddzielone spacją). */
  exec_allowed_tools: "Bash Edit Write Read Glob Grep mcp__vibe-kanban",
  /** Ile Kroków może być realizowanych równolegle przez vk run. */
  concurrency: "1",
  /** Opcjonalny model dla subagenta (puste = domyślny). */
  exec_model: "",
};
