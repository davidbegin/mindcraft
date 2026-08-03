#!/usr/bin/env bash
# Prefer: `just up`  (see Justfile for start/stop/status/join)
set -euo pipefail
cd "$(dirname "$0")"
export PATH="/opt/homebrew/opt/node@20/bin:$PATH"

if [[ -f code/.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source code/.env
  set +a
  echo "Loaded API keys from code/.env"
else
  echo "WARNING: code/.env not found. Put OPENAI_API_KEY there (or use keys.json)."
fi

echo "Starting Mindcraft bot (OpenAI / andy)..."
echo "  UI:        http://localhost:8080"
echo "  Minecraft: 127.0.0.1:55916"
echo "Join tips:   just join"
exec node main.js "$@"
