---
description: Pierwsza konfiguracja i start serwera vibe-kanban w Dockerze
argument-hint: "[katalog z repozytoriami] [port]"
allowed-tools: Bash
---

Skonfiguruj i uruchom serwer vibe-kanban (UI + API) w Dockerze.

1. Ustal katalog, w którym użytkownik trzyma lokalne repozytoria git (zostanie zamontowany
   w kontenerze pod tą samą ścieżką). Argumenty: `$ARGUMENTS`. Jeśli nie podano katalogu,
   zapytaj użytkownika (zaproponuj `~/projects`, jeśli istnieje). Na WSL odradzaj `/mnt/c/...`.
2. Uruchom: `"${CLAUDE_PLUGIN_ROOT}/scripts/vk-setup.sh" KATALOG [PORT]`
   (pierwszy build może potrwać kilka minut — uruchom z odpowiednio długim timeoutem).
3. Jeśli się udało, podaj adres UI (http://localhost:PORT) i powiedz w 2–3 zdaniach, co dalej:
   dodać repozytoria (UI → Repozytoria albo poproś mnie), utworzyć ticket (`/vibe-kanban:ticket`
   albo UI), a polecenia planowania i realizacji kopiować z UI do terminala.
4. Jeśli się nie udało, pokaż błąd i najbardziej prawdopodobną przyczynę (Docker nie działa,
   brak uprawnień do docker, zajęty port, brak `git config --global user.email`).

Od następnych sesji Claude Code serwer będzie uruchamiany automatycznie, jeśli nie działa.
