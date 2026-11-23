# vibe-kanban — zasady pracy w repo

## Wersja pluginu (obowiązkowo)

Przy **każdej** zmianie w repo podbij `version` w `.claude-plugin/plugin.json` — w tym samym commicie
albo PR. Bez tego `claude plugin update vibe-kanban@vibe-kanban` nie pobierze nowej wersji
(Claude Code porównuje numer wersji).

- poprawka / drobna zmiana → patch (`0.4.0` → `0.4.1`),
- nowa funkcja → minor (`0.4.1` → `0.5.0`),
- zmiana niezgodna wstecz (np. format bazy, polecenia) → major albo minor z adnotacją w opisie PR.

Plugin instaluje się z domyślnej gałęzi (`master`), a obraz Dockera publikuje CI z `master` —
zmiana trafia do użytkowników dopiero po merge'u do `master`.

## Sprawdzenie przed commitem

```bash
npm run typecheck && npm run build
```
