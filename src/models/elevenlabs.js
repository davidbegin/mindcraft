import { getKey } from '../utils/keys.js';

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
        throw new Error(`ElevenLabs TTS request failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    return buffer.toString('base64');
}

export const TTSConfig = {
    sendAudioRequest: sendAudioRequest,
    baseUrl: 'https://api.elevenlabs.io/v1',
}
