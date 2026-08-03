#!/usr/bin/env bash
# Sync .env -> keys.json for Mindcraft.
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"

ENV_FILE=""
for candidate in .env code/.env; do
  if [[ -f "$candidate" ]]; then
    ENV_FILE="$candidate"
    break
  fi
done

if [[ -z "$ENV_FILE" ]]; then
  echo "No .env found. Create .env in the repo root with OPENAI_API_KEY=sk-..." >&2
  exit 1
fi

ENV_FILE="$ENV_FILE" python3 - <<'PY'
from pathlib import Path
import json
import os

env = Path(os.environ["ENV_FILE"])
keys = {
    "OPENAI_API_KEY": "",
    "OPENAI_ORG_ID": "",
    "GEMINI_API_KEY": "",
    "ANTHROPIC_API_KEY": "",
    "REPLICATE_API_KEY": "",
    "GROQCLOUD_API_KEY": "",
    "HUGGINGFACE_API_KEY": "",
    "QWEN_API_KEY": "",
    "XAI_API_KEY": "",
    "MISTRAL_API_KEY": "",
    "DEEPSEEK_API_KEY": "",
    "GHLF_API_KEY": "",
    "HYPERBOLIC_API_KEY": "",
    "NOVITA_API_KEY": "",
    "OPENROUTER_API_KEY": "",
    "CEREBRAS_API_KEY": "",
    "MERCURY_API_KEY": "",
}
for line in env.read_text().splitlines():
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    name, value = line.split("=", 1)
    if name in keys:
        keys[name] = value.strip().strip('"').strip("'")

if not keys["OPENAI_API_KEY"]:
    raise SystemExit(f"{env} has no OPENAI_API_KEY")

Path("keys.json").write_text(json.dumps(keys, indent=4) + "\n")
print(f"Synced keys.json from {env}")
PY
