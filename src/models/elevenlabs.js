import { getKey } from '../utils/keys.js';

// ElevenLabs nests its diagnosis under `detail`, e.g.
// {"detail":{"status":"quota_exceeded","message":"You have 0 credits remaining..."}}
// Older / proxy responses sometimes use a bare string detail instead.
function parseErrorBody(body) {
    try {
        const parsed = JSON.parse(body);
        const detail = parsed?.detail;
        if (typeof detail === 'string') return { code: null, message: detail };
        return {
            code: detail?.status || detail?.code || null,
            message: detail?.message || parsed?.message || null,
        };
    } catch {
        return { code: null, message: null };
    }
}

/**
 * Failures carry the HTTP status and the provider's own status code so callers
 * can tell "out of credits" from "bad key" from "rate limited" without having
 * to pattern-match an English sentence.
 */
export class ElevenLabsTTSError extends Error {
    constructor({ status, code, message, body }) {
        super(message || `ElevenLabs TTS request failed (${status})`);
        this.name = 'ElevenLabsTTSError';
        this.provider = 'elevenlabs';
        this.status = status;
        this.code = code;
        this.body = body;
    }
}

const sendAudioRequest = async (text, model, voice, url, options = {}) => {
    const baseUrl = url || TTSConfig.baseUrl;
    const res = await fetch(`${baseUrl}/text-to-speech/${voice}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: {
            'xi-api-key': getKey('ELEVENLABS_API_KEY'),
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            text: text,
            model_id: model,
            ...(options.voiceSettings ? { voice_settings: options.voiceSettings } : {}),
        }),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        const { code, message } = parseErrorBody(body);
        throw new ElevenLabsTTSError({
            status: res.status,
            code,
            message: message
                ? `ElevenLabs TTS request failed (${res.status}): ${message}`
                : `ElevenLabs TTS request failed (${res.status}): ${body.slice(0, 300)}`,
            body: body.slice(0, 300),
        });
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    return buffer.toString('base64');
}

export const TTSConfig = {
    sendAudioRequest: sendAudioRequest,
    baseUrl: 'https://api.elevenlabs.io/v1',
}
