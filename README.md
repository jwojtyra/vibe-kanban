# vibe-kanban

Lokalny kanban do planowania i realizacji zadań z **Claude Code**.

- Zadanie (np. z linku do Jiry) → sesja Claude rozbija je na **podzadania** z opisem,
  „jaki problem rozwiązuje”, kryteriami akceptacji, **kolejnością i zależnościami**.
- Po akceptacji planu subagenci realizują podzadania w osobnych **git worktree**.
- Wynik trafia do **Review**: diff, komentarze do linii, sesja z agentem, akceptacja → **Done** (lokalny merge).
- **Wszystko lokalnie.** Nic nie jest pushowane. **Strona nie wysyła niczego do Claude** — pracują
  wyłącznie sesje uruchamiane z terminala poleceniami kopiowanymi z UI.

Specyfikacja: [docs/SPEC.md](docs/SPEC.md).

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
- **Repozytoria dodawane w UI muszą leżeć w katalogu podanym w `docker-setup.sh`.** Tylko on
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

1. **+ Projekt** — nazwa i jedno lub kilka lokalnych repozytoriów git (np. `frontend` i `backend`).
   Jeden ticket może obejmować zmiany we wszystkich repo projektu; każde podzadanie dotyczy jednego repo.
2. **+ Zadanie** — „Z ticketu”: wklej link (`…/browse/PROJ-123`), ID staje się kluczem zadania.
   Uzupełnij opis, **założenia**, **linki** dla agenta, **zasoby referencyjne** (ścieżka lub URL git,
   tylko do odczytu) i ewentualnie własne **prompty**.
3. **Planowanie** — skopiuj `vk plan PROJ-123` do terminala. Otwiera się zawsze ta sama sesja
   Claude (wznawiana), która przez MCP widzi zadanie i tworzy podzadania (status Draft).
4. **Akceptacja planu** w UI (edycja, kolejność ↑↓, zależności) → Todo.
5. **Realizacja** — `vk run PROJ-123`. Subagent (`claude -p`) dla każdego podzadania w jego worktree.
   Kolejne rusza, gdy jego zależności są w Review/Done. Koniec → Review, błąd → Blocked.
6. **Review** — w UI diff i komentarze (klik w linię). Do pracy nad poprawkami:
   - `vk open PROJ-123-2` — stała sesja review w worktree podzadania (zna komentarze i zadanie),
   - `vk open PROJ-123-2 --agent` — wznawia sesję subagenta, który implementował.
7. **Akceptuj → Done** — merge `--no-ff` do gałęzi `vk/PROJ-123`. Push robisz sam.

## Projekty z wieloma repozytoriami

- Podzadanie ma przypisane repo (`repo` w `vk_create_subtask`). Sesja planowania widzi wszystkie
  repozytoria (`--add-dir`), a sesja implementacji pracuje w worktree swojego repo i widzi
  pozostałe **tylko do odczytu** (np. żeby sprawdzić kontrakt API).
- Zależności mogą łączyć repo (frontend czeka na backend). Wpływają wtedy na kolejność, a baza
  podzadania to gałąź zadania w jego repo. W obrębie jednego repo zależne podzadanie startuje
  z gałęzi poprzednika (stacked).
- Gałąź zadania `vk/PROJ-123` powstaje w każdym repo, którego dotyczą podzadania. Push robisz
  ręcznie w każdym z nich.

## Dodawanie projektów: UI, MCP, API

**UI:** „+ Projekt” albo „Ustawienia projektu” → Repozytoria.

**MCP (np. agent zakłada projekt sam):** `vk mcp` bez `--task` działa w trybie globalnym.
Zarejestruj go raz w Claude Code, a każda sesja będzie mogła zarządzać projektami:

```bash
claude mcp add vibe-kanban -s user -- vk mcp
```

Potem wystarczy poprosić Claude, np.: „utwórz w vibe-kanban projekt Sklep z repozytoriami
~/projects/shop-frontend (frontend) i ~/projects/shop-backend (backend), a potem zadanie
z ticketu https://…/browse/SHOP-500”. Narzędzia trybu globalnego: `vk_list_projects`,
`vk_get_project`, `vk_create_project`, `vk_add_repo`, `vk_update_project`, `vk_create_task`.
Są też dostępne w sesjach zadań, więc sesja planowania może dołączyć brakujące repo.

**API HTTP:**

```bash
curl -X POST localhost:4777/api/projects -H 'Content-Type: application/json' -d '{
  "name": "Sklep",
  "repos": [
    { "path": "~/projects/shop-frontend", "name": "frontend", "description": "React SPA" },
    { "path": "~/projects/shop-backend",  "name": "backend",  "base_branch": "main" }
  ]}'
curl -X POST localhost:4777/api/projects/1/repos -H 'Content-Type: application/json' \
  -d '{ "path": "~/projects/shop-mobile", "name": "mobile" }'
```

W Dockerze wszystkie repozytoria projektu muszą leżeć w katalogu podanym w `docker-setup.sh`.

## Polecenia CLI

| Polecenie | Opis |
| --- | --- |
| `vk serve [-p 4777]` | UI i API (tylko 127.0.0.1) |
| `vk plan <TASK>` | sesja planowania (stała, wznawiana) |
| `vk run <TASK> [-c N]` | realizacja podzadań wg kolejności i zależności |
| `vk exec <SUBTASK> [--force]` | subagent dla jednego podzadania (`--force` ignoruje niegotowe zależności) |
| `vk open <SUBTASK> [--agent] [--fresh]` | sesja pracy/review nad podzadaniem |
| `vk mcp [--task <TASK>] [--subtask <KEY>]` | serwer MCP; bez `--task` tryb globalny (projekty, repo, zadania) |

## Narzędzia MCP dostępne w sesjach

Projekty i zadania: `vk_list_projects`, `vk_get_project`, `vk_create_project`, `vk_add_repo`,
`vk_update_project`, `vk_create_task`. Zadanie i podzadania: `vk_get_task`, `vk_list_subtasks`, `vk_get_subtask`, `vk_create_subtask`, `vk_update_subtask`,
`vk_delete_subtask`, `vk_reorder_subtasks`, `vk_next_subtasks`, `vk_list_comments`,
`vk_resolve_comment`, `vk_submit_for_review`.

## Dane i git

- Baza: `~/.vk/vk.db` (zmienna `VK_HOME` zmienia katalog), logi subagentów: `~/.vk/logs`.
- Worktree: `~/.vk/worktrees/<projekt>/<repo>/<KLUCZ>`; zasoby git klonowane do `~/.vk/cache`.
- Sesja planowania działa w stałym katalogu `~/.vk/plan/<KLUCZ>` z repozytoriami dodanymi przez `--add-dir`
  (z ich `CLAUDE.md`), dzięki czemu da się ją zawsze wznowić, nawet po dodaniu repo.
- Gałęzie: `vk/PROJ-123` (zadanie), `vk/PROJ-123-2` (podzadanie). Podzadanie zależne od
  niezakończonego startuje z gałęzi zależności; gdy baza pójdzie do przodu, UI proponuje Rebase.

## Rozwój

```bash
npm run build:server && vk serve   # backend
npm run dev:ui                     # UI z hot reload na :5173 (proxy /api → :4777)
npm run typecheck
```
