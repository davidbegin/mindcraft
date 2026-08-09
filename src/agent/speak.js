import { exec, spawn } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { TTSConfig as gptTTSConfig } from '../models/gpt.js';
import { TTSConfig as geminiTTSConfig } from '../models/gemini.js';
import { TTSConfig as elevenLabsTTSConfig } from '../models/elevenlabs.js';
import { resolveVoice, getElevenLabsModel } from './tts_voices.js';
import { noteVoiceFailure, noteVoiceSuccess } from './tts_health.js';

let speakingQueue = []; // each item: {text, isSystem, volume, audioData, ready}
let isSpeaking = false;
let speechGeneration = 0;
let activePlayer = null;
let activeItem = null;
// Host TTS mute modes:
// - off: normal playback
// - soft: still generate and queue for catch-up, but do not play yet
// - hard: drop enqueue + clear queue (saves ElevenLabs credits)
let muteMode = 'off';
// Bots that are out of the game. Their lines are dropped at enqueue, so a bot
// that dies mid-sentence stops spending ElevenLabs credits as well as stopping
// talking.
const silencedBots = new Set();

const MUTE_MODES = Object.freeze(['off', 'soft', 'hard']);

/** Current mute mode: off | soft | hard. */
export function getMuteMode() {
    return muteMode;
}

/** Whether host TTS is muted (soft or hard). */
export function isMuted() {
    return muteMode !== 'off';
}

/**
 * Set mute mode. Hard mute clears the queue. Leaving soft/hard for off resumes
 * queued catch-up playback.
 */
export function setMuteMode(next) {
    const mode = MUTE_MODES.includes(next) ? next : 'off';
    muteMode = mode;
    if (mode === 'hard') clearSpeechQueue();
    if (mode === 'off' && !isSpeaking) processQueue();
    return muteMode;
}

/**
 * Mute or unmute host TTS. Muting uses hard mute (drop + save credits) for
 * backward compatibility with the simple toggle API.
 * Returns whether any mute is active.
 */
export function setMuted(next) {
    setMuteMode(next ? 'hard' : 'off');
    return isMuted();
}

/** Flip between off and hard mute; return whether muted afterward. */
export function toggleMuted() {
    return setMuteMode(muteMode === 'off' ? 'hard' : 'off') !== 'off';
}

/** Whether this bot's lines are currently being dropped. */
export function isBotSilenced(botName) {
    return silencedBots.has(String(botName));
}

/**
 * Stop voicing one bot and drop the backlog it has already queued. Called when
 * a bot dies or is eliminated: TTS runs several lines ahead of the game, so
 * without this a bot keeps narrating for a while after it left.
 */
export function silenceBot(botName) {
    silencedBots.add(String(botName));
    clearSpeechQueue({ botName: String(botName) });
}

/** Let a silenced bot speak again, e.g. for a new game or a juror's turn. */
export function allowBot(botName) {
    return silencedBots.delete(String(botName));
}

/**
 * Drop speech that has not played yet and stop the line currently playing.
 * A generation token also invalidates TTS requests that are still resolving,
 * so stale audio cannot re-enter playback after an urgent announcement.
 *
 * Pass a `botName` to flush only that bot. The host queue is shared, so a whole
 * flush would also swallow the narrator line calling the elimination that
 * prompted it.
 */
export function clearSpeechQueue({ botName = null } = {}) {
    if (botName === null) {
        speakingQueue = [];
        speechGeneration++;
        isSpeaking = false;
        const player = activePlayer;
        activePlayer = null;
        activeItem = null;
        try {
            player?.kill();
        } catch {}
        return;
    }
    speakingQueue = speakingQueue.filter(item => {
        if (item.botName !== botName) return true;
        item.cancelled = true;
        return false;
    });
    if (activeItem?.botName !== botName) return;
    // The line playing (or still generating) belongs to this bot. Its playback
    // handlers bail out once it is cancelled, so hand the queue on from here or
    // everyone else waits forever behind a bot that is no longer in the game.
    activeItem.cancelled = true;
    const player = activePlayer;
    activePlayer = null;
    activeItem = null;
    try {
        player?.kill();
    } catch {}
    isSpeaking = false;
    processQueue();
}

// A queued line is dead either because its own bot was flushed or because a
// full flush moved the queue on past it while its TTS request was in flight.
function isStale(item) {
    return item.cancelled === true || item.generation !== speechGeneration;
}

/**
 * Normalize a profile speak_model into {provider, model, voice, url}.
 * Supports 'system', '{provider}', '{provider}/{model}', '{provider}/{model}/{voice}',
 * and the object form {api, model, voice, url}. For elevenlabs, missing model/voice
 * fall back to voices.json / the per-bot voice registry.
 */
function parseModelSpec(speak_model, botName) {
    const raw = speak_model || 'system';
    let provider, model, voice, url;
    if (typeof raw === 'string') {
        [provider, model, voice] = raw.split('/');
    } else {
        provider = raw.api;
        model = raw.model;
        voice = raw.voice;
        url = raw.url;
    }
    if (provider === 'system') return { provider: 'system' };
    if (provider === 'elevenlabs') {
        model = model || getElevenLabsModel();
        voice = resolveVoice(botName, voice);
        url = url || elevenLabsTTSConfig.baseUrl;
    } else if (provider === 'openai') {
        url = url || gptTTSConfig.baseUrl;
    } else if (provider === 'google') {
        url = url || geminiTTSConfig.baseUrl;
    }
    return { provider, model, voice, url };
}

export function isSystemSpeakModel(speak_model) {
    return parseModelSpec(speak_model).provider === 'system';
}

/**
 * Generate speech audio for the given text and return it as base64 mp3/wav.
 * Returns null for the 'system' provider (system TTS has no audio data).
 */
export async function generateSpeech(text, speak_model, botName) {
    const spec = parseModelSpec(speak_model, botName);
    if (spec.provider === 'system') return null;
    const providers = {
        elevenlabs: elevenLabsTTSConfig,
        openai: gptTTSConfig,
        google: geminiTTSConfig,
    };
    const config = providers[spec.provider];
    if (!config) throw new Error(`TTS Provider ${spec.provider} is not supported.`);
    try {
        const audio = await config.sendAudioRequest(text, spec.model, spec.voice, spec.url);
        noteVoiceSuccess();
        return audio;
    } catch (err) {
        noteVoiceFailure(err, { provider: spec.provider, botName });
        throw err;
    }
}

/**
 * Queue speech for playback on the host machine.
 * `volume` is 0-100 (proximity chat scales this by distance).
 * `audioPromise` lets callers reuse audio they already started generating
 * (e.g. for recordings) instead of paying for a second TTS request.
 */
export function playSpeech({ text, model, botName, volume = 100, audioPromise = null }) {
    if (muteMode === 'hard' || silencedBots.has(String(botName))) {
        // The caller may already have a TTS request in flight; dropping the line
        // must not surface as an unhandled rejection.
        audioPromise?.catch(() => {});
        return;
    }
    const spec = parseModelSpec(model, botName);
    const item = {
        text,
        botName,
        isSystem: spec.provider === 'system',
        volume,
        audioData: null,
        ready: Promise.resolve(),
        generation: speechGeneration,
        cancelled: false,
    };
    if (!item.isSystem) {
        const promise = audioPromise || generateSpeech(text, model, botName);
        item.ready = promise
            .then(data => { item.audioData = data; })
            .catch(err => { item.error = err; });
    }
    speakingQueue.push(item);
    // Soft mute keeps generating into the queue but does not start playback.
    if (!isSpeaking && muteMode === 'off') processQueue();
}

// Backwards-compatible fire-and-forget entry point.
export function speak(text, speak_model, botName) {
    playSpeech({ text, model: speak_model, botName });
}

async function processQueue() {
    isSpeaking = true;
    if (speakingQueue.length === 0) {
        isSpeaking = false;
        return;
    }
    const item = speakingQueue.shift();
    activeItem = item;
    const { text: txt, isSystem, volume } = item;
    if (txt.trim() === '') {
        activeItem = null;
        isSpeaking = false;
        processQueue();
        return;
    }

    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';

    // wait for preprocessing if needed
    try {
        await item.ready;
        if (isStale(item)) return;
        if (item.error) throw item.error;
    } catch (err) {
        // A line abandoned because its bot left the game is not a voice fault,
        // so it must not raise an alarm in the control room.
        if (!isStale(item)) noteVoiceFailure(err, { botName: item.botName });
        activeItem = null;
        isSpeaking = false;
        processQueue();
        return;
    }

    if (isSystem) {
        // system TTS
        const cmd = isWin
            ? `powershell -NoProfile -Command "Add-Type -AssemblyName System.Speech; \
            $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate=2; \
            $s.Speak('${txt.replace(/'/g,"''")}'); $s.Dispose()"`
            : isMac
            ? `say "${txt.replace(/"/g,'\\"')}"`
            : `espeak "${txt.replace(/"/g,'\\"')}"`;

        const player = exec(cmd, err => {
            if (isStale(item)) return;
            activePlayer = null;
            activeItem = null;
            if (err) console.error('TTS error', err);
            isSpeaking = false;
            processQueue();
        });
        activePlayer = player;

    }
    else {
        // audioData was already fetched when the item was queued
        const audioData = item.audioData;

        if (!audioData) {
            noteVoiceFailure(new Error('No audio data was ready for playback'), { provider: 'host' });
            activeItem = null;
            isSpeaking = false;
            processQueue();
            return;
        }

        const vol = Math.max(0, Math.min(100, Math.round(volume ?? 100)));
        try {
            if (isWin) {
                const tmpPath = path.join(os.tmpdir(), `tts_${Date.now()}.mp3`);
                await fs.writeFile(tmpPath, Buffer.from(audioData, 'base64'));

                const player = spawn('ffplay', ['-nodisp', '-autoexit', '-volume', String(vol), '-loglevel', 'quiet', tmpPath], {
                    stdio: 'ignore', windowsHide: true
                });
                activePlayer = player;
                player.on('error', async (err) => {
                    if (isStale(item)) return;
                    activePlayer = null;
                    activeItem = null;
                    noteVoiceFailure(err, { provider: 'host', botName: item.botName });
                    try { await fs.unlink(tmpPath); } catch {}
                    isSpeaking = false;
                    processQueue();
                });
                player.on('exit', async () => {
                    try { await fs.unlink(tmpPath); } catch {}
                    if (isStale(item)) return;
                    activePlayer = null;
                    activeItem = null;
                    isSpeaking = false;
                    processQueue();
                });

            } else {
                const player = spawn('ffplay', ['-nodisp','-autoexit','-volume',String(vol),'pipe:0'], {
                    stdio: ['pipe','ignore','ignore']
                });
                activePlayer = player;
                player.on('error', (err) => {
                    if (isStale(item)) return;
                    activePlayer = null;
                    activeItem = null;
                    noteVoiceFailure(err, { provider: 'host', botName: item.botName });
                    isSpeaking = false;
                    processQueue();
                });
                player.stdin.on('error', () => {});
                player.stdin.write(Buffer.from(audioData, 'base64'));
                player.stdin.end();
                player.on('exit', () => {
                    if (isStale(item)) return;
                    activePlayer = null;
                    activeItem = null;
                    isSpeaking = false;
                    processQueue();
                });
            }
        } catch (e) {
            noteVoiceFailure(e, { provider: 'host', botName: item.botName });
            activeItem = null;
            isSpeaking = false;
            processQueue();
        }
    }
}
