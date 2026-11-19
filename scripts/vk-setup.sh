#!/usr/bin/env bash
# Pierwsza konfiguracja i start serwera vibe-kanban w Dockerze.
# Użycie: scripts/vk-setup.sh KATALOG_Z_REPOZYTORIAMI [PORT]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for c in docker git curl; do
  command -v "$c" >/dev/null 2>&1 || { echo "vibe-kanban: brak polecenia $c" >&2; exit 1; }
done
docker info >/dev/null 2>&1 || { echo "vibe-kanban: Docker nie działa albo brak uprawnień (dodaj użytkownika do grupy docker)" >&2; exit 1; }
"$ROOT/scripts/docker-setup.sh" "$@"
# shellcheck disable=SC1091
. "$HOME/.vk/docker.env"
echo "Buduję i uruchamiam kontener (pierwszy raz może potrwać kilka minut)..."
"$ROOT/scripts/vk-docker.sh" up -d --build
for _ in $(seq 1 60); do
  if curl -fsS "http://localhost:${VK_PORT}/api/health" >/dev/null 2>&1; then
    echo "vibe-kanban działa: http://localhost:${VK_PORT}"
    exit 0
  fi
  sleep 1
done
echo "vibe-kanban: serwer nie odpowiada — sprawdź: $ROOT/scripts/vk-docker.sh logs" >&2
exit 1
