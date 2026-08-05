import fs from 'fs';
import path from 'path';

// ElevenLabs premade voices, chosen for variety (male/female, accents, ages,
// energies) so a colony of bots doesn't all sound the same. Voice IDs are the
// public ElevenLabs stock voice IDs.
const VOICES = [
    ['Adam', 'pNInz6obpgDQGcFmaJgB', 'deep American male'],
    ['Rachel', '21m00Tcm4TlvDq8ikWAM', 'calm American female'],
    ['Clyde', '2EiwWnXFnvU5JabPnv8n', 'gruff war-veteran male'],
    ['Domi', 'AZnzlk1XvdvUeBnXmlld', 'strong, confident female'],
    ['Fin', 'D38z5RcWu1voky8WS1ja', 'old Irish sailor'],
    ['Sarah', 'EXAVITQu4vr4xnSDxMaL', 'soft American female'],
    ['Antoni', 'ErXwobaYiN019PkySvjV', 'well-rounded male'],
    ['Charlie', 'IKne3meq5aSn9XLyUdCD', 'casual Australian male'],
    ['George', 'JBFqnCBsd6RMkjVDRZzb', 'warm British male'],
    ['Callum', 'N2lVS1w4EtoT3dr4eOWO', 'intense, gravelly male'],
    ['Harry', 'SOYHLrjzK2X1ezoPC6cr', 'anxious young male'],
    ['Liam', 'TX3LPaxmHKxFdv7VOQHJ', 'articulate young male'],
    ['Dorothy', 'ThT5KcBeYPX3keUQqHPh', 'pleasant British female'],
    ['Josh', 'TxGEqnHWrfWFTfGW9XjX', 'deep young male'],
    ['Arnold', 'VR6AewLTigWG4xSOukaG', 'crisp, commanding male'],
    ['Charlotte', 'XB0fDUnXU5powFXDhCwa', 'seductive Swedish female'],
    ['Alice', 'Xb7hH8MSUJpSbSDYk0k2', 'confident British female'],
    ['Matilda', 'XrExE9yKIg1WjnnlVkGX', 'friendly American female'],
    ['Jeremy', 'bVMeCyTHy58xNoL34h3p', 'excitable Irish male'],
    ['Michael', 'flq6f7yk4E4fJM5XTYuZ', 'old American male'],
    ['Ethan', 'g5CIjZEefAph4nQFvHAz', 'whispery young male'],
    ['Gigi', 'jBpfuIE2acCO8z3wKNLl', 'childish, animated female'],
    ['Freya', 'jsCqWAovK2LkecY7zXl4', 'expressive American female'],
    ['Brian', 'nPczCjzI2devNBz1zQrb', 'deep narrator male'],
    ['Daniel', 'onwK4e9ZLuTAKqWW03F9', 'authoritative British male'],
    ['Lily', 'pFZP5JQG7iQjIQuC4Bku', 'velvety British female'],
    ['Bill', 'pqHfZKP75CvOlQylNhV4', 'trustworthy old male'],
    ['Jessie', 't0jbNlBVZ17f02VDIeMI', 'raspy old male'],
    ['Sam', 'yoZ06aMxZJJ28mfd3POQ', 'fast-talking American male'],
    ['Glinda', 'z9fAnlkpzviPz146aGWa', 'witchy female'],
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

/**
 * Resolve the ElevenLabs voice ID for a bot.
 * Priority: explicit voice from the profile's speak_model, then the
 * voices.json "bots" mapping, then the voices.json default_voice, then a
 * deterministic pick from VOICE_POOL.
 */
export function resolveVoice(botName, requestedVoice = null) {
    if (requestedVoice) return poolLookup(requestedVoice);
    const config = loadConfig();
    const pinned = config.bots?.[botName];
    if (pinned) return poolLookup(pinned);
    if (typeof config.default_voice === 'string' && config.default_voice.trim()) {
        return poolLookup(config.default_voice.trim());
    }
    return VOICE_POOL[autoVoiceName(botName)];
}
