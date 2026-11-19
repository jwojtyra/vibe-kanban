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

## Wymagania

- Node.js ≥ 22.13 (wbudowany `node:sqlite`)
- git
- Claude Code (`claude`) w PATH

## Uruchomienie (Linux / WSL2)

Serwer (UI + API) działa w Dockerze. Na hoście potrzebne są tylko: **git**, **Claude Code**
i **Node.js ≥ 22.13** dla polecenia `vk`, które otwiera sesje Claude w Twoim terminalu.
Sesje Claude celowo nie są w kontenerze: korzystają z Twojego logowania, terminala i plików repo.

```bash
git clone https://github.com/jwojtyra/vibe-kanban && cd vibe-kanban

# 1. Serwer w Dockerze
./scripts/docker-setup.sh ~/projects     # katalog, w którym trzymasz repozytoria
docker compose up -d --build             # UI: http://localhost:4777

# 2. CLI `vk` na hoście (do sesji Claude)
npm install && npm run build && npm link
```

Ważne:
- **Repozytoria dodawane do listy muszą leżeć w katalogu podanym w `docker-setup.sh`.** Tylko on
  jest zamontowany w kontenerze. Montowanie jest pod tą samą ścieżką co na hoście, bo git
  zapisuje absolutne ścieżki worktree.
- Kontener działa z Twoim UID/GID i Twoim `~/.gitconfig`, więc commity i merge'e mają Twoją
  tożsamość, a pliki nie należą do roota.
- `~/.vk` (baza, worktree, logi) jest wspólny dla kontenera i `vk` na hoście.
- Port jest wystawiony tylko na `127.0.0.1`.
- **WSL2:** trzymaj repozytoria w systemie plików WSL (np. `~/projects`), nie na `/mnt/c/...`.
  Docker może być Docker Desktop z integracją WSL albo Docker Engine zainstalowany w WSL.
  Polecenia `vk` uruchamiaj w terminalu WSL.

Aktualizacja: `git pull && docker compose up -d --build && npm run build`.
Logi serwera: `docker compose logs -f`. Zatrzymanie: `docker compose down` (dane zostają w `~/.vk`).

### Bez Dockera

```bash
npm install && npm run build && npm link
vk serve        # http://localhost:4777
```

Bez `npm link` ustaw w UI → Ustawienia → Uruchamianie pole „Polecenie vk” na
`node /ścieżka/do/vibe-kanban/dist/cli.js`.

## Przepływ

1. **Repozytoria** (górny pasek) — dodaj lokalne repo git: nazwa, ścieżka, gałąź bazowa,
   komenda testów (trafia do kontekstu agenta).
2. **+ Ticket** — link do ticketu (ID staje się kluczem), opis, repozytoria. Uzupełnij
   **założenia**, **linki** dla agenta, **zasoby referencyjne** (tylko do odczytu) i ewentualnie **prompty**.
3. **Planowanie** — skopiuj `vk plan SHOP-412` do terminala. Zawsze ta sama sesja Claude (wznawiana),
   która przez MCP widzi ticket i zapisuje plan: Etapy → Funkcje → Kroki (status Draft).
4. **Akceptacja planu** w UI — cały plan albo pojedyncze elementy; wcześniej możesz edytować
   pola, kolejność (↑↓) i zależności.
5. **Realizacja** — `vk run SHOP-412`. Subagent (`claude -p`) dla każdego Kroku w jego worktree,
   w kolejności planu; Krok rusza, gdy jego zależności (także odziedziczone po Funkcji i Etapie)
   są w Review/Done. Koniec → Review, błąd → Blocked.
6. **Review Kroku** — diff i komentarze (klik w linię). Do poprawek:
   - `vk open SHOP-412-1.2.3` — stała sesja review w worktree Kroku (zna komentarze, Funkcję i ticket),
   - `vk open SHOP-412-1.2.3 --agent` — wznawia sesję subagenta, który wykonał Krok.
7. **Akceptuj → Done** — merge `--no-ff` do gałęzi `vk/SHOP-412` w repo Kroku. Funkcja i Etap są
   „done”, gdy wszystkie ich Kroki są done. Push robisz sam w każdym repo.

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

**MCP (np. agent zakłada ticket sam):** `vk mcp` bez `--task` działa w trybie globalnym.
Zarejestruj go raz w Claude Code:

```bash
claude mcp add vibe-kanban -s user -- vk mcp
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

## Polecenia CLI

| Polecenie | Opis |
| --- | --- |
| `vk serve [-p 4777]` | UI i API (tylko 127.0.0.1) |
| `vk plan <TICKET>` | sesja planowania (stała, wznawiana) |
| `vk run <TICKET> [-c N]` | realizacja Kroków wg kolejności i zależności |
| `vk exec <KROK> [--force]` | subagent dla jednego Kroku (`--force` ignoruje niegotowe zależności) |
| `vk open <KROK> [--agent] [--fresh]` | sesja pracy/review nad Krokiem |
| `vk mcp [--task <TICKET>] [--item <KROK>]` | serwer MCP; bez `--task` tryb globalny |

## Narzędzia MCP

- Globalne: `vk_list_repos`, `vk_add_repo`, `vk_update_repo`, `vk_list_tasks`, `vk_create_task`.
- Ticket: `vk_get_task`, `vk_attach_repo`, `vk_get_item`, `vk_create_stage`, `vk_create_feature`,
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
