# vibe-kanban — specyfikacja (wersja robocza)

Lokalne narzędzie do planowania i realizacji zadań programistycznych z Claude Code.
Zadanie główne jest rozbijane przez Claude na podzadania z kolejnością i zależnościami,
podzadania wykonują sesje Claude w osobnych git worktree, a wynik trafia do Review,
gdzie człowiek ogląda diff, komentuje i akceptuje.

## Zasady nadrzędne

1. **Wszystko lokalnie.** Nic nie jest wypychane (`git push`, PR) — robi to człowiek ręcznie.
2. **Strona (UI) nigdy nie rozmawia z Claude.** UI tylko zarządza danymi i pokazuje
   polecenia do skopiowania. Całą pracę wykonują sesje Claude Code uruchamiane
   z terminala (`vk plan`, `vk run`, `vk open`).
3. **Sesje znają kanban przez MCP.** Każda sesja dostaje serwer MCP `vibe-kanban`
   ograniczony do swojego zadania.
4. **Zasoby referencyjne są tylko do odczytu.**

## Pojęcia

### Projekt
Grupa lokalnych repozytoriów git (np. `frontend`, `backend`). Każde ma nazwę, ścieżkę,
gałąź bazową i opis. Do tego założenia projektu i zasoby referencyjne projektu.
Jedno zadanie (ticket) może obejmować zmiany we wszystkich repozytoriach projektu.
Projekty i repozytoria można tworzyć w UI, przez API HTTP i przez MCP (tryb globalny `vk mcp`).

### Zasoby referencyjne (read-only)
Lokalna ścieżka albo URL repozytorium git (klonowane do `~/.vk/cache`).
Zakresy: **globalne** (np. repo wzorcowe organizacji), **projekt**, **zadanie**.
Do sesji trafiają przez `--add-dir`, a zapis jest blokowany regułami
`permissions.deny` (`Edit`/`Write`/`NotebookEdit` na tych ścieżkach) + instrukcją w prompcie.

### Prompty
Trzy szablony z placeholderami `{{...}}`:
- **planowanie** — analiza i rozbicie zadania na podzadania,
- **implementacja** — wykonanie podzadania przez subagenta,
- **review** — praca nad podzadaniem po komentarzach.

Domyślne są globalne (Ustawienia), zadanie może je nadpisać.

### Zadanie (główne)
- tytuł, opis,
- **ticket**: link (np. Jira) → automatycznie wyciągany ID (`PROJ-123`), który staje się kluczem zadania,
- linki dla agenta,
- własne założenia,
- zasoby referencyjne zadania,
- nadpisania promptów,
- stała sesja planowania (`plan_session_id`) — zawsze ta sama, wznawiana.

### Podzadanie
- klucz `<KLUCZ_ZADANIA>-<n>` (np. `PROJ-123-2`),
- **repozytorium** projektu, którego dotyczy (dokładnie jedno),
- tytuł, opis, **jaki problem rozwiązuje**, kryteria akceptacji,
- pozycja (kolejność) i zależności,
- status: `draft → todo → in_progress → review → done` (+ `blocked`),
- gałąź / worktree, sesja subagenta, sesja review, komentarze z review.

## Przepływ

1. **Utworzenie zadania** w UI (ewentualnie „Dodaj z ticketu”).
2. **Planowanie**: UI pokazuje `vk plan PROJ-123`. W terminalu otwiera się Claude Code
   w repo projektu, zawsze w tej samej sesji (pierwszy raz `--session-id`, potem `--resume`),
   z MCP kanbana, kontekstem zadania i zasobami. Claude tworzy podzadania (`draft`).
3. **Akceptacja planu** w UI (edycja, kolejność, zależności) → `todo`.
4. **Realizacja**: UI pokazuje `vk run PROJ-123`. Proces w terminalu uruchamia kolejno
   subagentów (`claude -p` w worktree podzadania, ze stałym `--session-id`).
   Kolejne podzadanie rusza, gdy wszystkie jego zależności są w `review` lub `done`.
   Zakończone podzadanie (commit) → `review`. Błąd → `blocked`.
5. **Review** w UI: diff podzadania, komentarze do linii. Polecenia:
   - `vk open PROJ-123-2` — stała sesja review w worktree podzadania; zna komentarze
     i kontekst zadania głównego (przez MCP),
   - `vk open PROJ-123-2 --agent` — wznawia sesję subagenta, który implementował.
6. **Akceptacja** → `done`: lokalny merge (`--no-ff`) gałęzi podzadania do gałęzi zadania,
   usunięcie worktree podzadania (gałąź zostaje).

## Git

- Gałąź zadania: `vk/<KLUCZ>` w każdym repo, którego dotyczą podzadania (z `base_branch` tego repo),
  worktree w `~/.vk/worktrees/<projekt>/<repo>/<KLUCZ>`.
- Gałąź podzadania: `vk/<KLUCZ>-<n>` w repo podzadania, osobny worktree.
- Baza podzadania: gałąź zadania w jego repo; jeżeli zależność z TEGO SAMEGO repo nie jest
  jeszcze `done` — gałąź tej zależności (stacked). Zależności z innych repo wpływają tylko
  na kolejność. Po `done` zależności baza przełącza się na gałąź zadania.
- Sesja implementacji/review: zapis tylko w worktree podzadania; pozostałe repozytoria
  projektu dostępne tylko do odczytu.
- Diff do review: `merge-base(baza, HEAD)` → drzewo robocze (+ pliki nieśledzone).
- Jeżeli baza poszła do przodu (np. poprawki w zależności), UI pokazuje „wymaga rebase”
  i przycisk Rebase (przy konflikcie — abort, rozwiązanie w sesji).

## Architektura

- TypeScript / Node ≥ 22.13, jeden pakiet, CLI `vk`.
- Dane: SQLite (`node:sqlite`) w `~/.vk/vk.db` (`VK_HOME` nadpisuje katalog).
- `vk serve` — lokalny serwer HTTP (127.0.0.1) z API i UI (React + Vite).
- `vk mcp --task KEY [--subtask KEY]` — serwer MCP (stdio) dla sesji.
- `vk plan | run | exec | open` — uruchamianie sesji Claude Code.

## Poza MVP / do doprecyzowania

- pobieranie treści ticketu z Jira API (teraz: tylko ID + link),
- równoległość > 1 (jest ustawienie, domyślnie 1),
- zakresy zasobów „per organizacja” jako osobny byt (teraz: globalne),
- twarda ochrona read-only także przed Bash (np. kopia z `chmod -R a-w`),
- historia/logi sesji w UI w ładniejszej formie.
