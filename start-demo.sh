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
  # Read values literally rather than sourcing: keys like CurseForge's bcrypt
  # tokens contain `$2...`, which `source` would expand as a positional
  # parameter and abort under `set -u`.
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line#"${line%%[![:space:]]*}"}"
    if [[ -z "$line" || "$line" == '#'* || "$line" != *=* ]]; then
      continue
    fi
    line="${line#export }"
    name="${line%%=*}"
    value="${line#*=}"
    if [[ ! "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      continue
    fi
    value="${value%"${value##*[![:space:]]}"}"
    if [[ ${#value} -ge 2 && ( "$value" == '"'*'"' || "$value" == "'"*"'" ) ]]; then
      value="${value:1:${#value}-2}"
    fi
    export "$name=$value"
  done < "$ENV_FILE"
  echo "Loaded API keys from $ENV_FILE"
else
  echo "WARNING: no .env found. Put OPENAI_API_KEY in .env (or use keys.json)."
fi

echo "Starting Mindcraft bot (OpenAI / andy)..."
echo "  UI:        http://localhost:8080"
echo "  Minecraft: 127.0.0.1:55916"
echo "Join tips:   just join"
exec node main.js "$@"
