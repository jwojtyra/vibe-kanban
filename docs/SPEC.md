# vibe-kanban — specyfikacja (wersja robocza)

Lokalne narzędzie do planowania i realizacji ticketów z Claude Code. Ticket jest rozbijany przez
Claude na plan w trzech poziomach (Etap → Funkcja → Krok), Kroki wykonują sesje Claude w osobnych
git worktree, a wynik trafia do Review, gdzie człowiek ogląda diff, komentuje i akceptuje.

## Zasady nadrzędne

1. **Wszystko lokalnie.** Nic nie jest wypychane (`git push`, PR) — robi to człowiek ręcznie.
2. **Strona (UI) nigdy nie rozmawia z Claude.** UI tylko zarządza danymi i pokazuje
   polecenia do skopiowania. Całą pracę wykonują sesje Claude Code uruchamiane
   z terminala (`vk plan`, `vk run`, `vk open`).
3. **Sesje znają kanban przez MCP.** Każda sesja dostaje serwer MCP `vibe-kanban`
   ograniczony do swojego ticketu.
4. **Zasoby referencyjne i „cudze” repozytoria są tylko do odczytu.**

## Pojęcia

### Repozytorium (globalna lista)
Lokalne repo git: nazwa, ścieżka, gałąź bazowa, komenda testów, opis. Dodawane raz
(UI, API, MCP), wskazywane w ticketach. Nie ma pojęcia „projektu”.

### Ticket
- tytuł, opis, link (np. Jira) → automatycznie wyciągany ID, który staje się kluczem (`SHOP-412`),
- repozytoria, których dotyczy (jedno lub kilka),
- linki dla agenta, własne założenia (oprócz globalnych z Ustawień),
- zasoby referencyjne ticketu (oprócz globalnych),
- nadpisania promptów,
- stała sesja planowania (`plan_session_id`) — zawsze ta sama, wznawiana.

### Plan — trzy poziomy

| Poziom | Nazwa | Klucz | Rola |
|---|---|---|---|
| 1 | **Etap** | `SHOP-412-1` | Gruby klocek, służy do podziału na mniejsze części. |
| 2 | **Funkcja** | `SHOP-412-1.2` | Dowozi zmianę funkcjonalną (API lub zachowanie). Ma **testy akceptacyjne** dowodzące, że funkcjonalność działa. Może obejmować kilka repo (przez Kroki). |
| 3 | **Krok** | `SHOP-412-1.2.3` | Najmniejszy klocek w **jednym** repo. Wykonywany przez subagenta w osobnym worktree, osobno recenzowany i akceptowany. Rodzaj: `test` albo `impl`. |

- Status Kroku: `draft → todo → in_progress → review → done` (+ `blocked`).
- Etap i Funkcja mają zapisany tylko `draft`/`todo` (akceptacja); dalszy status jest wyliczany
  z Kroków (wszystkie done → done, któryś blocked → blocked itd.).
- Zależności: tylko między elementami tego samego poziomu. Zależność Funkcji lub Etapu przenosi się
  na wszystkie ich Kroki (efektywne zależności). Cykle — także pośrednie — są odrzucane.

### Testy (test-first)
Sposób testowania wynika z promptów i analizy, a nie z twardych bramek w narzędziu. Domyślny prompt
planowania prowadzi do podejścia test-first:
1. Funkcja definiuje scenariusze testów akceptacyjnych (pole `acceptance_tests`).
2. Pierwszy Krok Funkcji (w danym repo) ma rodzaj `test` — dodaje testy, które są **czerwone**.
3. Kolejne Kroki (`impl`) zależą od Kroku z testami (startują z jego gałęzi) i krok po kroku
   je zazieleniają; po ostatnim Kroku Funkcji wszystkie jej testy są zielone.

Komenda testów repo trafia do kontekstu agenta (`{{step.test_command}}`).

### Zasoby referencyjne (read-only)
Lokalna ścieżka albo URL repozytorium git (klonowane do `~/.vk/cache`). Zakresy: globalne i ticket.
Do sesji trafiają przez `--add-dir`, a zapis jest blokowany regułami `permissions.deny` + instrukcją w prompcie.

### Prompty
Trzy szablony z placeholderami `{{...}}`: planowanie, implementacja Kroku, review Kroku.
Domyślne są globalne (Ustawienia), ticket może je nadpisać.

## Przepływ

1. **Ticket** w UI (lub przez MCP/API) z wybranymi repozytoriami.
2. **Planowanie**: `vk plan SHOP-412` — stała sesja Claude w `~/.vk/plan/SHOP-412`, z repozytoriami
   ticketu przez `--add-dir`, MCP kanbana i zasobami. Claude tworzy Etapy, Funkcje i Kroki (Draft).
3. **Akceptacja** w UI — cały plan albo pojedyncze elementy (→ Todo).
4. **Realizacja**: `vk run SHOP-412` — subagenci (`claude -p`, stałe `--session-id`) wykonują Kroki
   w kolejności planu; Krok rusza, gdy jego efektywne zależności są w Review/Done i przodkowie są
   zaakceptowani. Koniec → Review, błąd → Blocked.
5. **Review Kroku**: diff, komentarze do linii, `vk open KROK` (stała sesja review) lub
   `vk open KROK --agent` (wznowienie sesji subagenta).
6. **Akceptacja Kroku** → Done: lokalny merge `--no-ff` do gałęzi ticketu w repo Kroku.

## Git

- Gałąź ticketu `vk/SHOP-412` w każdym repo, w którym są Kroki (z gałęzi bazowej repo),
  worktree w `~/.vk/worktrees/<repo>/SHOP-412`.
- Gałąź Kroku `vk/SHOP-412-1.2.3`, osobny worktree.
- Baza Kroku: gałąź ticketu; jeśli efektywna zależność z TEGO SAMEGO repo nie jest jeszcze done —
  gałąź ostatniej (w kolejności planu) takiej zależności (stacked). Po jej merge'u baza przechodzi
  na gałąź ticketu; UI proponuje Rebase, gdy baza poszła do przodu.
- Merge Kroku wymaga, by jego efektywne zależności były done.
- Diff Kroku: od `merge-base(baza, HEAD)` do drzewa roboczego; po merge'u — z commita merge'a.

## Architektura

- TypeScript / Node ≥ 22.13, jeden pakiet, CLI `vk`.
- Dane: SQLite (`node:sqlite`) w `~/.vk/vk.db` (`VK_HOME` nadpisuje katalog).
- `vk serve` — lokalny serwer HTTP (127.0.0.1) z API i UI (React + Vite); może działać w Dockerze.
- `vk mcp [--task KEY] [--item KROK]` — serwer MCP (stdio); bez `--task` tryb globalny.
- `vk plan | run | exec | open` — uruchamianie sesji Claude Code na hoście.

## Poza MVP / do doprecyzowania

- pobieranie treści ticketu z Jira API (teraz: tylko ID + link; agent może użyć własnego MCP Jiry),
- opcjonalna weryfikacja testów przez vk (uruchomienie komendy testów przed Review),
- zbiorczy widok diffu Funkcji (wszystkie jej Kroki naraz),
- przenoszenie elementów planu między rodzicami,
- twarda ochrona read-only także przed Bash.
