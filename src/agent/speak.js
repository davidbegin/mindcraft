import { exec, spawn } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { TTSConfig as gptTTSConfig } from '../models/gpt.js';
import { TTSConfig as geminiTTSConfig } from '../models/gemini.js';
import { TTSConfig as elevenLabsTTSConfig } from '../models/elevenlabs.js';
import { resolveVoice, getElevenLabsModel } from './tts_voices.js';

let speakingQueue = []; // each item: {text, isSystem, volume, audioData, ready}
let isSpeaking = false;
let speechGeneration = 0;
let activePlayer = null;
// Global mute for host TTS. When muted, new lines are dropped entirely (no
// TTS request, no playback) so muting also saves ElevenLabs credits.
let muted = false;

/** Whether host TTS is currently muted. */
export function isMuted() {
    return muted;
}

/**
 * Mute or unmute host TTS. Muting also stops whatever is playing now and
 * drops the queue, so the next line does not sneak through after the toggle.
 * Returns the resulting mute state.
 */
export function setMuted(next) {
    muted = !!next;
    if (muted) clearSpeechQueue();
    return muted;
}

/** Flip the mute state and return the new value. */
export function toggleMuted() {
    return setMuted(!muted);
}

/**
 * Drop speech that has not played yet and stop the line currently playing.
 * A generation token also invalidates TTS requests that are still resolving,
 * so stale audio cannot re-enter playback after an urgent announcement.
 */
export function clearSpeechQueue() {
    speakingQueue = [];
    speechGeneration++;
    isSpeaking = false;
    const player = activePlayer;
    activePlayer = null;
    try {
        player?.kill();
    } catch {}
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
    if (spec.provider === 'elevenlabs') {
        return elevenLabsTTSConfig.sendAudioRequest(text, spec.model, spec.voice, spec.url);
    } else if (spec.provider === 'openai') {
        return gptTTSConfig.sendAudioRequest(text, spec.model, spec.voice, spec.url);
    } else if (spec.provider === 'google') {
        return geminiTTSConfig.sendAudioRequest(text, spec.model, spec.voice, spec.url);
    }
    throw new Error(`TTS Provider ${spec.provider} is not supported.`);
}

/**
 * Queue speech for playback on the host machine.
 * `volume` is 0-100 (proximity chat scales this by distance).
 * `audioPromise` lets callers reuse audio they already started generating
 * (e.g. for recordings) instead of paying for a second TTS request.
 */
export function playSpeech({ text, model, botName, volume = 100, audioPromise = null }) {
    if (muted) return;
    const spec = parseModelSpec(model, botName);
    const item = {
        text,
        isSystem: spec.provider === 'system',
        volume,
        audioData: null,
        ready: Promise.resolve(),
        generation: speechGeneration,
    };
    if (!item.isSystem) {
        const promise = audioPromise || generateSpeech(text, model, botName);
        item.ready = promise
            .then(data => { item.audioData = data; })
            .catch(err => { item.error = err; });
    }
    speakingQueue.push(item);
    if (!isSpeaking) processQueue();
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
    const { text: txt, isSystem, volume } = item;
    if (txt.trim() === '') {
        isSpeaking = false;
        processQueue();
        return;
    }

    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';

    // wait for preprocessing if needed
    try {
        await item.ready;
        if (item.generation !== speechGeneration) return;
        if (item.error) throw item.error;
    } catch (err) {
        console.error('[TTS] preprocess error', err);
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
            if (item.generation !== speechGeneration) return;
            activePlayer = null;
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
            console.error('[TTS] No audio data ready');
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
                    if (item.generation !== speechGeneration) return;
                    activePlayer = null;
                    console.error('[TTS] ffplay error', err);
                    try { await fs.unlink(tmpPath); } catch {}
                    isSpeaking = false;
                    processQueue();
                });
                player.on('exit', async () => {
                    try { await fs.unlink(tmpPath); } catch {}
                    if (item.generation !== speechGeneration) return;
                    activePlayer = null;
                    isSpeaking = false;
                    processQueue();
                });

            } else {
                const player = spawn('ffplay', ['-nodisp','-autoexit','-volume',String(vol),'pipe:0'], {
                    stdio: ['pipe','ignore','ignore']
                });
                activePlayer = player;
                player.on('error', (err) => {
                    if (item.generation !== speechGeneration) return;
                    activePlayer = null;
                    console.error('[TTS] ffplay error', err);
                    isSpeaking = false;
                    processQueue();
                });
                player.stdin.on('error', () => {});
                player.stdin.write(Buffer.from(audioData, 'base64'));
                player.stdin.end();
                player.on('exit', () => {
                    if (item.generation !== speechGeneration) return;
                    activePlayer = null;
                    isSpeaking = false;
                    processQueue();
                });
            }
        } catch (e) {
            console.error('[TTS] Audio error', e);
            isSpeaking = false;
            processQueue();
        }
    }
}
