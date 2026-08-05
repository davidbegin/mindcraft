#!/usr/bin/env node
// Regenerates skins for every agent in the colony roster (plus any profile
// files passed as arguments). Normally skins are generated automatically when
// an agent registers; this pre-populates ./skins so the MC container mount
// and the web UI have them from the start.
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ensureSkin, SKINS_DIR } from '../src/mindcraft/skins.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const statePath = path.join(root, 'colony', 'state.json');

const targets = new Map();

if (existsSync(statePath)) {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    for (const [name, agent] of Object.entries(state.agents || {})) {
        targets.set(name, agent.profile?.model);
    }
}

for (const arg of process.argv.slice(2)) {
    const profile = JSON.parse(readFileSync(arg, 'utf8'));
    targets.set(profile.name, profile.model);
}

if (targets.size === 0) {
    console.error('No agents found (no colony/state.json and no profile args).');
    process.exit(1);
}

for (const [name, model] of targets) {
    const skin = ensureSkin(name, model);
    console.log(`${name.padEnd(16)} ${skin.label.padEnd(16)} -> skins/${name}.png`);
}
console.log(`\n${targets.size} skins written to ${SKINS_DIR}`);
