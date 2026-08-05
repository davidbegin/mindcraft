import fs from 'fs';
import path from 'path';

// Goofy character voices from this account's ElevenLabs library, chosen so
// the colony sounds like a cartoon ensemble rather than a newsroom. Every ID
// was verified to generate with the account's API key.
const VOICES = [
    ['Giggles', 'VE5rsMNTeE1frCCSXNIC', 'wacky cartoon goofball'],
    ['Sasquatch', 'a8p00hpqmTpR1cLnk76X', 'sassy Australian sasquatch'],
    ['Grimblewood', 'ouL9IsyrSnUkCmfnD02u', 'grumpy old gnome'],
    ['ToonMarshal', 'lE5ZJB6jGeeuvSNxOvs2', 'excitable toon character'],
    ['Timmy', 'mrQhZWGbb2k9qWJb5qeA', 'anxious nerd'],
    ['Clifford', 'H2CgnIux8C0XLWQ97uPA', 'drawling western cowboy'],
    ['RadioClyde', 'QMJTqaMXmGnG8TCm8WQG', 'vintage radio announcer'],
    ['Inferno', 'zYcjlYFOd3taleS0gkk3', 'arrogant cartoon villain'],
    ['Myrddin', 'oR4uRy4fHDUGGISL0Rev', 'theatrical old wizard'],
    ['Nawlins', 'ERbFfgajma1nPOBNQw6U', 'smooth New Orleans gentleman'],
    ['Aerisita', '03vEurziQfq3V8WZhQvn', 'sassy upbeat diva'],
    ['Bridget', '17BwYbWZaIZnGAgXe6XS', 'insufferable rich snob'],
    ['Cyrien', 'AFkIMdmeB0MMrr1tgGds', 'charming flirty rogue'],
    ['BostonBob', 'Gf1KYedBUv2F4rCJhVFJ', 'wicked-pissah Boston guy'],
    ['Laura', 'FGY2WhTYpPnrIDTdsKH5', 'quirky sassy enthusiast'],
    ['Jessica', 'cgSgspJ2msm6clMCkdW9', 'playful bubbly optimist'],
    ['DudeDavis', 'Umdp1GYPcONfcWXrMinP', 'chill surfer dude'],
    ['BlouB', 'ySaYS84ykPC7FKlpD4ag', 'modulated Canadian weirdo'],
    ['Trickster', 'N2lVS1w4EtoT3dr4eOWO', 'husky trickster'],
    ['Gigi', 'jBpfuIE2acCO8z3wKNLl', 'childish animated squeaker'],
];

export const VOICE_POOL = Object.fromEntries(VOICES.map(([name, id]) => [name, id]));
export const VOICE_DESCRIPTIONS = Object.fromEntries(VOICES.map(([name, , desc]) => [name, desc]));

export const DEFAULT_ELEVENLABS_MODEL = 'eleven_flash_v2_5';

// User config, editable by hand or from the mindserver web UI (Voices modal).
// Pins bots to a specific voice (a VOICE_POOL name or a raw ElevenLabs voice
// ID), sets a default voice for unpinned bots, and sets the TTS model:
// { "elevenlabs_model": "...", "default_voice": "Adam", "bots": { "andy": "Adam" } }
const VOICES_CONFIG_PATH = path.resolve(process.env.MINDCRAFT_VOICES_PATH || './voices.json');

const CONFIG_README = 'Per-bot ElevenLabs voice assignments, editable from the mindserver UI (Voices). '
    + 'Values are voice names from VOICE_POOL in src/agent/tts_voices.js, or raw ElevenLabs voice IDs. '
    + "'default_voice' is used for bots not listed under 'bots'; when omitted, each bot gets a stable, "
    + "automatically-assigned voice from the pool. 'elevenlabs_model' sets the TTS model for all bots.";

let _configCache = null;
let _configMtime = 0;

function loadConfig() {
    try {
        const mtime = fs.statSync(VOICES_CONFIG_PATH).mtimeMs;
        if (!_configCache || mtime !== _configMtime) {
            _configCache = JSON.parse(fs.readFileSync(VOICES_CONFIG_PATH, 'utf8'));
            _configMtime = mtime;
        }
        return _configCache;
    } catch (_) {
        return {};
    }
}

export function getElevenLabsModel() {
    return loadConfig().elevenlabs_model || DEFAULT_ELEVENLABS_MODEL;
}

/** Normalized view of voices.json for editing (UI) and inspection. */
export function getVoicesConfig() {
    const config = loadConfig();
    const bots = {};
    for (const [name, voice] of Object.entries(config.bots || {})) {
        if (typeof voice === 'string' && voice.trim()) bots[name] = voice.trim();
    }
    return {
        elevenlabs_model: config.elevenlabs_model || DEFAULT_ELEVENLABS_MODEL,
        default_voice: typeof config.default_voice === 'string' && config.default_voice.trim()
            ? config.default_voice.trim()
            : null,
        bots,
    };
}

/**
 * Writes voices.json. Agents pick the change up on their next spoken line
 * because loadConfig re-reads the file whenever its mtime changes.
 */
export function saveVoicesConfig({ elevenlabs_model, default_voice, bots } = {}) {
    const cleanBots = {};
    for (const [name, voice] of Object.entries(bots || {})) {
        if (typeof name === 'string' && name.trim() && typeof voice === 'string' && voice.trim()) {
            cleanBots[name.trim()] = voice.trim();
        }
    }
    const config = {
        _readme: CONFIG_README,
        elevenlabs_model: (typeof elevenlabs_model === 'string' && elevenlabs_model.trim())
            ? elevenlabs_model.trim()
            : DEFAULT_ELEVENLABS_MODEL,
        ...(typeof default_voice === 'string' && default_voice.trim()
            ? { default_voice: default_voice.trim() }
            : {}),
        bots: cleanBots,
    };
    fs.writeFileSync(VOICES_CONFIG_PATH, JSON.stringify(config, null, 4) + '\n');
    _configCache = null;
    _configMtime = 0;
    return getVoicesConfig();
}

function poolLookup(nameOrId) {
    if (!nameOrId) return null;
    const match = Object.keys(VOICE_POOL).find(
        n => n.toLowerCase() === String(nameOrId).toLowerCase()
    );
    if (match) return VOICE_POOL[match];
    // Not a pool name: assume it's already a raw ElevenLabs voice ID.
    return String(nameOrId);
}

function poolName(nameOrId) {
    if (!nameOrId) return null;
    return Object.keys(VOICE_POOL).find(
        name => name.toLowerCase() === String(nameOrId).toLowerCase()
    ) || String(nameOrId);
}

// djb2: stable across restarts and processes so a bot always gets the same
// voice even when nothing is pinned in voices.json.
function hashName(name) {
    let hash = 5381;
    for (let i = 0; i < name.length; i++) {
        hash = ((hash << 5) + hash + name.charCodeAt(i)) >>> 0;
    }
    return hash;
}

/** The pool voice a bot falls back to when nothing is pinned or defaulted. */
export function autoVoiceName(botName) {
    const names = Object.keys(VOICE_POOL);
    return names[hashName(String(botName || 'bot')) % names.length];
}

/** Resolve the human-facing pool name, or preserve a raw ElevenLabs voice ID. */
export function resolveVoiceName(botName, requestedVoice = null) {
    if (requestedVoice) return poolName(requestedVoice);
    const config = loadConfig();
    const pinned = config.bots?.[botName];
    if (pinned) return poolName(pinned);
    if (typeof config.default_voice === 'string' && config.default_voice.trim()) {
        return poolName(config.default_voice.trim());
    }
    return autoVoiceName(botName);
}

/**
 * Resolve the ElevenLabs voice ID for a bot.
 * Priority: explicit voice from the profile's speak_model, then the
 * voices.json "bots" mapping, then the voices.json default_voice, then a
 * deterministic pick from VOICE_POOL.
 */
export function resolveVoice(botName, requestedVoice = null) {
    return poolLookup(resolveVoiceName(botName, requestedVoice));
}
