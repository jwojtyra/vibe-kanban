#!/usr/bin/env bash
# Serwer MCP vibe-kanban dla Claude Code: działa w kontenerze, połączenie przez `docker exec -i`.
# Czeka chwilę na kontener (np. gdy hook właśnie go uruchamia). Komunikaty tylko na stderr.
if ! docker info >/dev/null 2>&1; then
  echo "vibe-kanban: Docker nie działa albo brak uprawnień do docker — uruchom Dockera, potem /mcp → reconnect." >&2
  exit 1
fi
for _ in $(seq 1 45); do
  [ "$(docker inspect -f '{{.State.Running}}' vibe-kanban 2>/dev/null)" = "true" ] && \
    exec docker exec -i vibe-kanban node --no-warnings /app/dist/cli.js mcp "$@"
  [ -f "$HOME/.vk/docker.env" ] || break
  sleep 1
done
echo "vibe-kanban: kontener nie działa. Uruchom /vibe-kanban:setup (pierwszy raz) albo sprawdź ~/.vk/docker.log, potem /mcp → reconnect." >&2
exit 1
