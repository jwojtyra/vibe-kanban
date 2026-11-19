/**
 * Domyślne ustawienia i prompty. Można je zmienić w UI (Ustawienia),
 * a prompty dodatkowo nadpisać per zadanie.
 *
 * Placeholdery: {{task.key}}, {{task.title}}, {{task.description}}, {{task.ticket_id}},
 * {{task.ticket_url}}, {{task.assumptions}}, {{task.links}}, {{project.name}},
 * {{project.assumptions}}, {{resources}}, {{subtask.key}}, {{subtask.title}},
 * {{subtask.description}}, {{subtask.problem}}, {{subtask.acceptance}}, {{subtask.deps}},
 * {{comments}}
 */

export const DEFAULT_PLAN_PROMPT = `Zadanie {{task.key}}: {{task.title}}

Przeanalizuj to zadanie i rozbij je na podzadania.

1. Zapoznaj się z kontekstem: narzędzie vk_get_task (opis, ticket, linki, założenia, zasoby referencyjne).
   Jeśli podano ticket i masz dostęp do narzędzi Jira/Atlassian — pobierz jego treść.
2. Przeanalizuj kod repozytorium i zasoby referencyjne (tylko do odczytu).
3. Zadaj mi pytania, jeśli coś jest niejasne, zanim zaproponujesz plan.
4. Zaproponuj plan, a po mojej akceptacji utwórz podzadania narzędziem vk_create_subtask:
   - każde podzadanie małe, samodzielnie weryfikowalne, możliwe do review jako jeden diff,
   - opis: co dokładnie zrobić; problem: jaki problem rozwiązuje; kryteria akceptacji,
   - ustaw kolejność i zależności (depends_on) tam, gdzie podzadanie wymaga wyniku innego.
Nie implementuj niczego w tej sesji.`;

export const DEFAULT_IMPL_PROMPT = `Zaimplementuj podzadanie {{subtask.key}}: {{subtask.title}}

Opis:
{{subtask.description}}

Jaki problem rozwiązuje:
{{subtask.problem}}

Kryteria akceptacji:
{{subtask.acceptance}}

Zasady:
- Pracujesz w worktree tego podzadania (bieżący katalog). Rób zmiany tylko tutaj.
- Pełny kontekst zadania głównego: vk_get_task; szczegóły podzadania: vk_get_subtask.
- Trzymaj się założeń zadania i projektu. Zasoby referencyjne są tylko do odczytu.
- Nie rób git push ani nie twórz PR.
- Uruchom dostępne testy/lint, jeśli to możliwe.
- Na koniec zrób commit i wywołaj vk_submit_for_review z krótkim podsumowaniem.`;

export const DEFAULT_REVIEW_PROMPT = `Pracujemy nad podzadaniem {{subtask.key}}: {{subtask.title}} (etap review).

Pobierz komentarze z review narzędziem vk_list_comments oraz kontekst vk_get_subtask / vk_get_task.
Omów ze mną komentarze, wprowadź uzgodnione poprawki, a rozwiązane komentarze oznacz vk_resolve_comment.
Po zmianach zrób commit. Nie rób git push.`;

export const DEFAULT_SETTINGS: Record<string, string> = {
  plan_prompt: DEFAULT_PLAN_PROMPT,
  impl_prompt: DEFAULT_IMPL_PROMPT,
  review_prompt: DEFAULT_REVIEW_PROMPT,
  /** Polecenie wstawiane do copy-paste (np. "vk" albo "node /sciezka/dist/cli.js"). */
  cli_command: "vk",
  /** Polecenie uruchamiające Claude Code. */
  claude_command: "claude",
  /** Tryb uprawnień subagenta (vk run / vk exec): default | acceptEdits | bypassPermissions. */
  exec_permission_mode: "acceptEdits",
  /** Dodatkowo dozwolone narzędzia subagenta (oddzielone spacją). */
  exec_allowed_tools: "Bash Edit Write Read Glob Grep mcp__vibe-kanban",
  /** Ile podzadań może być realizowanych równolegle przez vk run. */
  concurrency: "1",
  /** Opcjonalny model dla subagenta (puste = domyślny). */
  exec_model: "",
};
