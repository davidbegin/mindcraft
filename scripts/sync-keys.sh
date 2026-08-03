#!/usr/bin/env bash
# Sync code/.env -> keys.json for Mindcraft.
set -euo pipefail
cd "$(dirname "$0")"
if [[ ! -f code/.env ]]; then
  echo "Missing code/.env with OPENAI_API_KEY" >&2
  exit 1
fi
python3 - <<'PY'
from pathlib import Path
import json
env = Path("code/.env")
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
Path("keys.json").write_text(json.dumps(keys, indent=4) + "\n")
print("Synced keys.json from code/.env")
PY
