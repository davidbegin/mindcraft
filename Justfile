# Mindcraft demo command center.
# Run `just` to list recipes.

set shell := ["bash", "-cu"]

default:
    @just --list

# Start Minecraft server + Andy bot (full demo)
up:
    @./scripts/demo.sh up

# Stop bot + Minecraft server
down:
    @./scripts/demo.sh down

# Restart everything
restart:
    @./scripts/demo.sh restart

# Start only the Minecraft server (Docker)
mc-up:
    @./scripts/demo.sh mc-up

# Stop only the Minecraft server
mc-down:
    @./scripts/demo.sh mc-down

# Start only the Mindcraft bot (expects Minecraft already up)
bot-up:
    @./scripts/demo.sh bot-up

# Stop only the Mindcraft bot
bot-down:
    @./scripts/demo.sh bot-down

# Show what's running
status:
    @./scripts/demo.sh status

# How to join from the Minecraft Java launcher
join:
    @./scripts/demo.sh join

# Tail demo / bot logs
logs:
    @tail -f /tmp/mindcraft-demo.log

# Open the Mindcraft web UI
ui:
    @open http://localhost:8080
