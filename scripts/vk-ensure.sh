#!/usr/bin/env bash
# Hook SessionStart pluginu: jeśli vibe-kanban był skonfigurowany, a kontener nie działa —
# uruchamia go w tle (bez blokowania startu sesji). Bez konfiguracji nic nie robi.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$HOME/.vk/docker.env" ] || exit 0
command -v docker >/dev/null 2>&1 || exit 0
if ! docker info >/dev/null 2>&1; then
  echo "vibe-kanban: Docker nie działa — serwer vibe-kanban nie został uruchomiony."
  exit 0
fi
[ "$(docker inspect -f '{{.State.Running}}' vibe-kanban 2>/dev/null)" = "true" ] && exit 0
nohup "$ROOT/scripts/vk-docker.sh" up -d --build >"$HOME/.vk/docker.log" 2>&1 </dev/null &
echo "vibe-kanban: uruchamiam serwer w tle (log: ~/.vk/docker.log)."
exit 0
