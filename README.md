# vibe-kanban

Lokalny kanban do planowania i realizacji ticketów z **Claude Code**.

- **Ticket** (np. z linku do Jiry) wskazuje repozytoria, których dotyczy — jedno lub kilka.
- Sesja Claude rozbija go na plan w trzech poziomach:
  1. **Etap** — gruby klocek, służy do podziału na mniejsze części,
  2. **Funkcja** — dowozi zmianę funkcjonalną (API lub zachowanie) i ma **testy akceptacyjne**
     dowodzące, że działa; może obejmować kilka repo,
  3. **Krok** — najmniejszy klocek w jednym repo; wykonuje go subagent w osobnym **git worktree**,
     wynik trafia do **Review** (diff, komentarze do linii, sesja z agentem) → **Done** (lokalny merge).
- Preferowane **test-first**: pierwszy Krok Funkcji dodaje czerwone testy, kolejne je zazieleniają
  (wynika z promptów i planu — możesz to zmienić w promptach).
- Kolejność i zależności na każdym poziomie; zależność Funkcji/Etapu obowiązuje wszystkie ich Kroki.
- **Wszystko lokalnie.** Nic nie jest pushowane. **Strona nie wysyła niczego do Claude** — pracują
  wyłącznie sesje uruchamiane z terminala poleceniami kopiowanymi z UI.

Specyfikacja: [docs/SPEC.md](docs/SPEC.md). Zrzuty ekranu: [docs/screenshots](docs/screenshots).

## Instalacja jako plugin Claude Code (zalecane)

W Claude Code:

```
/plugin marketplace add jwojtyra/vibe-kanban
/plugin install vibe-kanban@vibe-kanban
/vibe-kanban:setup ~/projects
```

- `/plugin install` pobiera aplikację, a `/vibe-kanban:setup` uruchamia serwer w Dockerze:
  pobiera gotowy obraz `ghcr.io/jwojtyra/vibe-kanban` (publikowany przez CI z `master`),
  a gdy jest niedostępny (np. prywatne repo bez `docker login ghcr.io`) — buduje go lokalnie
  (`VK_BUILD=1` wymusza build). Katalog to miejsce, w którym trzymasz repozytoria (montowany w kontenerze).
- Od następnych sesji hook pluginu sam uruchamia kontener w tle, jeśli nie działa.
- Plugin rejestruje MCP `vibe-kanban` (przez `docker exec`) i skill, który uczy Claude modelu
  Etap → Funkcja → Krok, oraz komendy `/vibe-kanban:setup` i `/vibe-kanban:ticket`
  (np. `/vibe-kanban:ticket https://acme.atlassian.net/browse/SHOP-500`).
- Planowanie i realizacja nadal idą przez polecenia kopiowane z UI — otwierają dedykowane
  sesje z pełnym kontekstem ticketu.
- Marketplace pobiera domyślną gałąź repozytorium; dla prywatnego repo potrzebny jest dostęp git
  (np. `gh auth login` lub klucz SSH).

## Uruchomienie bez pluginu (Linux / WSL2)

Wymagania na hoście: **Docker** (z dostępem do `docker` bez sudo), **git**, **bash**, **curl**
i **Claude Code** (`claude`, zalogowany). Node.js ani żadne aliasy nie są potrzebne.

```bash
git clone https://github.com/jwojtyra/vibe-kanban && cd vibe-kanban
./scripts/docker-setup.sh ~/projects     # katalog, w którym trzymasz repozytoria
docker compose up -d --build             # UI: http://localhost:4777
```

Polecenia z UI wklejasz wprost do terminala, np.:

```bash
bash <(curl -fsS 'http://localhost:4777/x/plan/SHOP-412')
```

Serwer zwraca krótki skrypt, który uruchamia `claude` na hoście z gotowymi argumentami (prompt,
kontekst, repozytoria, uprawnienia). Sesja łączy się z MCP vibe-kanban przez
`docker exec -i vibe-kanban …`, więc wszystko poza samym Claude działa w kontenerze. Sesje Claude
celowo nie są w kontenerze: korzystają z Twojego logowania, terminala i plików repo.
Polecenia `bash <(…)` działają w bash i zsh.

Ważne:
- **Repozytoria dodawane do listy muszą leżeć w katalogu podanym w `docker-setup.sh`.** Tylko on
  jest zamontowany w kontenerze, pod tą samą ścieżką co na hoście (git zapisuje absolutne ścieżki worktree).
- Kontener działa z Twoim UID/GID i Twoim `~/.gitconfig`, więc commity i merge'e mają Twoją
  tożsamość, a pliki nie należą do roota.
- `~/.vk` (baza, worktree, logi) jest wspólny dla kontenera i sesji Claude na hoście.
- Port jest wystawiony tylko na `127.0.0.1`.
- **WSL2:** trzymaj repozytoria w systemie plików WSL (np. `~/projects`), nie na `/mnt/c/...`.
  Docker może być Docker Desktop z integracją WSL albo Docker Engine w WSL. Polecenia z UI
  wklejaj w terminalu WSL.

Aktualizacja: `git pull && docker compose up -d --build`.
Logi serwera: `docker compose logs -f`. Zatrzymanie: `docker compose down` (dane zostają w `~/.vk`).

### Bez Dockera (opcjonalnie)

```bash
npm install && npm run build && npm link   # Node.js ≥ 22.13
vk serve                                   # http://localhost:4777
```

Polecenia `bash <(curl …)` działają także wtedy. Jeśli wolisz krótsze `vk plan SHOP-412`, wpisz `vk`
w Ustawienia → Uruchamianie → „Polecenie CLI”.

## Przepływ

1. **Repozytoria** (górny pasek) — dodaj lokalne repo git: nazwa, ścieżka, gałąź bazowa,
   komenda testów (trafia do kontekstu agenta).
2. **+ Ticket** — link do ticketu (ID staje się kluczem), opis, repozytoria. Uzupełnij
   **założenia**, **linki** dla agenta, **zasoby referencyjne** (tylko do odczytu) i ewentualnie **prompty**.
3. **Planowanie** — skopiuj polecenie planowania (`bash <(curl … /x/plan/SHOP-412)`) do terminala. Zawsze ta sama sesja Claude (wznawiana),
   która przez MCP widzi ticket i zapisuje plan: Etapy → Funkcje → Kroki (status Draft).
4. **Akceptacja planu** w UI — cały plan albo pojedyncze elementy; wcześniej możesz edytować
   pola, kolejność (↑↓) i zależności.
5. **Realizacja** — polecenie realizacji (`… /x/run/SHOP-412`). Subagent (`claude -p`) dla każdego Kroku w jego worktree,
   w kolejności planu; Krok rusza, gdy jego zależności (także odziedziczone po Funkcji i Etapie)
   są w Review/Done. Koniec → Review, błąd → Blocked.
6. **Review Kroku** — diff i komentarze (klik w linię). Do poprawek:
   - „Sesja pracy nad Krokiem” (`… /x/open/SHOP-412-1.2.3`) — stała sesja review w worktree Kroku
     (zna komentarze, Funkcję i ticket),
   - „Wznów sesję subagenta” (`… /x/open/SHOP-412-1.2.3?agent=1`) — kontekst agenta, który wykonał Krok.
7. **Akceptuj → Done** — merge `--no-ff` do gałęzi `vk/SHOP-412` w repo Kroku. Funkcja i Etap są
   „done”, gdy wszystkie ich Kroki są done. Push robisz sam w każdym repo.

**Pytania i blokery.** Agent zadaje pytania (`vk_ask_question`) przy ticketcie albo elemencie planu,
z propozycjami odpowiedzi — w UI wybierasz jedną (radio) albo wpisujesz własną (np. „omówmy na czacie”,
„mam dodatkowe pytania”). Elementy z otwartymi pytaniami są **żółte**, z blokerem lub pytaniem
blokującym — **czerwone**; ich Kroki (także podrzędne) nie ruszą w realizacji.

**Wytyczne i prompty poziomów.** „Wytyczne” (górny pasek) to dokument z Twoimi wymaganiami
technicznymi (jak pisać kod, czego nie robić) — trafia do każdej sesji; agent dopisuje do niego
na prośbę. W Ustawieniach są ogólne prompty dla poziomów Etap / Funkcja / Krok.

Formularze są ukryte — pola edytujesz przyciskiem „Dodaj” / „Edytuj”, który otwiera okno.

Widoki ticketu: **Plan** (drzewo Etap → Funkcja → Krok ze statusami) i **Tablica kroków**
(kanban Kroków z filtrem po repo i Funkcji).

## Klucze, gałęzie, test-first

- Klucze: `SHOP-412-1` (Etap), `SHOP-412-1.2` (Funkcja), `SHOP-412-1.2.3` (Krok).
- Gałąź ticketu `vk/SHOP-412` w każdym repo z Krokami; gałąź Kroku `vk/SHOP-412-1.2.3`.
- Krok zależny od niezakończonego Kroku **z tego samego repo** startuje z jego gałęzi (stacked) —
  np. Krok implementacji widzi czerwone testy z Kroku `test`. Zależności między repo wpływają
  tylko na kolejność. Gdy baza pójdzie do przodu, UI proponuje Rebase.
- Sesja Kroku pisze tylko w swoim worktree; pozostałe repo ticketu i zasoby są tylko do odczytu.

## Repozytoria i tickety: UI, MCP, API

**MCP (np. agent zakłada ticket sam):** plugin rejestruje je automatycznie. Bez pluginu
zarejestruj tryb globalny raz w Claude Code:

```bash
claude mcp add vibe-kanban -s user -- docker exec -i vibe-kanban node --no-warnings /app/dist/cli.js mcp
```

Potem np.: „dodaj do vibe-kanban repo ~/projects/shop-backend (backend, testy: go test ./...)
i ~/projects/shop-frontend (frontend, testy: npm test), a potem ticket z
https://…/browse/SHOP-500 dla obu repo”.

**API HTTP:**

```bash
curl -X POST localhost:4777/api/repos -H 'Content-Type: application/json' \
  -d '{ "path": "~/projects/shop-backend", "name": "backend", "test_command": "go test ./..." }'
curl -X POST localhost:4777/api/tasks -H 'Content-Type: application/json' \
  -d '{ "ticket_url": "https://acme.atlassian.net/browse/SHOP-500", "title": "Filtr", "repos": ["backend", "frontend"] }'
```

## Polecenia

Skrypty serwera (do wklejenia jako `bash <(curl -fsS 'http://localhost:4777/x/…')`):

| Ścieżka | Opis |
| --- | --- |
| `/x/plan/<TICKET>` | sesja planowania (stała, wznawiana) |
| `/x/run/<TICKET>` | realizacja Kroków wg kolejności i zależności |
| `/x/exec/<KROK>[?force=1]` | subagent dla jednego Kroku |
| `/x/open/<KROK>[?agent=1\|?fresh=1]` | sesja pracy/review nad Krokiem |

CLI `vk` (opcjonalne, bez Dockera lub z `npm link`):

| Polecenie | Opis |
| --- | --- |
| `vk serve [-p 4777]` | UI i API (tylko 127.0.0.1) |
| `vk plan <TICKET>` | sesja planowania (stała, wznawiana) |
| `vk run <TICKET> [-c N]` | realizacja Kroków wg kolejności i zależności |
| `vk exec <KROK> [--force]` | subagent dla jednego Kroku (`--force` ignoruje niegotowe zależności) |
| `vk open <KROK> [--agent] [--fresh]` | sesja pracy/review nad Krokiem |
| `vk mcp [--task <TICKET>] [--item <KROK>]` | serwer MCP; bez `--task` tryb globalny |

## Narzędzia MCP

- Globalne: `vk_list_repos`, `vk_add_repo`, `vk_update_repo`, `vk_list_tasks`, `vk_create_task`,
  `vk_get_guidelines`, `vk_add_guideline`.
- Ticket: `vk_get_task`, `vk_attach_repo`, `vk_get_item`, `vk_ask_question`, `vk_list_questions`,
  `vk_close_question`, `vk_set_blocker`, `vk_create_stage`, `vk_create_feature`,
  `vk_create_step`, `vk_update_item`, `vk_delete_item`, `vk_reorder_items`, `vk_next_steps`,
  `vk_list_comments`, `vk_resolve_comment`, `vk_submit_for_review`.

## Dane

- Baza: `~/.vk/vk.db` (zmienna `VK_HOME` zmienia katalog), logi subagentów: `~/.vk/logs`.
  Baza w starszym formacie jest przy starcie odkładana jako `vk.db.v*.bak` i tworzona od nowa.
- Worktree: `~/.vk/worktrees/<repo>/<KLUCZ>`; zasoby git klonowane do `~/.vk/cache`.
- Sesja planowania działa w stałym katalogu `~/.vk/plan/<KLUCZ>` z repozytoriami dodanymi przez
  `--add-dir` (z ich `CLAUDE.md`), więc da się ją zawsze wznowić, nawet po dodaniu repo.

## Rozwój

```bash
npm run build:server && vk serve   # backend
npm run dev:ui                     # UI z hot reload na :5173 (proxy /api → :4777)
npm run typecheck
```
