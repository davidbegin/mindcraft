#!/usr/bin/env bash
# Prefer: `just up`  (see Justfile for start/stop/status/join)
set -euo pipefail
cd "$(dirname "$0")"
export PATH="/opt/homebrew/opt/node@20/bin:$PATH"

ENV_FILE=""
for candidate in .env code/.env; do
  if [[ -f "$candidate" ]]; then
    ENV_FILE="$candidate"
    break
  fi
done

if [[ -n "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  echo "Loaded API keys from $ENV_FILE"
else
  echo "WARNING: no .env found. Put OPENAI_API_KEY in .env (or use keys.json)."
fi

echo "Starting Mindcraft bot (OpenAI / andy)..."
echo "  UI:        http://localhost:8080"
echo "  Minecraft: 127.0.0.1:55916"
echo "Join tips:   just join"
exec node main.js "$@"
