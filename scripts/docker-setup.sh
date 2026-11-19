#!/usr/bin/env bash
# Zapisuje konfigurację Dockera w ~/.vk/docker.env (i link .env w katalogu aplikacji)
# oraz przygotowuje katalogi na hoście.
# Użycie: ./scripts/docker-setup.sh [KATALOG_Z_REPOZYTORIAMI] [PORT]
set -euo pipefail
cd "$(dirname "$0")/.."

projects="${1:-${VK_PROJECTS_DIR:-$HOME/projects}}"
port="${2:-${VK_PORT:-4777}}"
projects="$(cd "$projects" 2>/dev/null && pwd || true)"
if [ -z "$projects" ]; then
  echo "Katalog z repozytoriami nie istnieje: ${1:-$HOME/projects}" >&2
  echo "Podaj go jawnie: ./scripts/docker-setup.sh /ścieżka/do/projektów" >&2
  exit 1
fi
case "$projects" in
  /mnt/[a-z]/*) echo "Uwaga: $projects leży na dysku Windows (/mnt/...). Trzymaj repozytoria w systemie plików WSL (np. ~/projects) — będzie szybciej i bez problemów z blokadami." >&2 ;;
esac

# katalogi muszą istnieć przed startem, inaczej Docker utworzy je jako root
mkdir -p "$HOME/.vk" "$HOME/.claude"
[ -f "$HOME/.gitconfig" ] || touch "$HOME/.gitconfig"
if ! git config --global user.email >/dev/null; then
  echo "Uwaga: brak git config --global user.email — merge'e w kontenerze się nie udadzą." >&2
fi

cat > "$HOME/.vk/docker.env" <<ENV
VK_UID=$(id -u)
VK_GID=$(id -g)
VK_HOST_HOME=$HOME
VK_PROJECTS_DIR=$projects
VK_PORT=$port
ENV
# link, żeby w katalogu aplikacji działało też zwykłe `docker compose up`
ln -sf "$HOME/.vk/docker.env" .env 2>/dev/null || cp "$HOME/.vk/docker.env" .env
echo "Zapisano ~/.vk/docker.env:"
cat "$HOME/.vk/docker.env"
echo
echo "Dalej: docker compose up -d --build   →  http://localhost:$port"
