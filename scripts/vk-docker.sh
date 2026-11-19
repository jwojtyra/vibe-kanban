#!/usr/bin/env bash
# docker compose dla vibe-kanban, niezależnie od bieżącego katalogu
# (konfiguracja z ~/.vk/docker.env, pliki z katalogu aplikacji / pluginu).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${VK_DOCKER_ENV:-$HOME/.vk/docker.env}"
if [ ! -f "$ENV_FILE" ]; then
  echo "vibe-kanban: brak $ENV_FILE — najpierw uruchom $ROOT/scripts/vk-setup.sh KATALOG_Z_REPOZYTORIAMI" >&2
  exit 1
fi
exec docker compose --project-name vibe-kanban --project-directory "$ROOT" --env-file "$ENV_FILE" -f "$ROOT/docker-compose.yml" "$@"
