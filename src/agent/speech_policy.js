import { containsCommand } from './commands/index.js';

const SPOKEN_COORDINATE_PATTERNS = [
    /\b[xyz]\s*[:=]?\s*~?-?\d+(?:\.\d+)?(?:\s*[,;/]?\s*[xyz]\s*[:=]?\s*~?-?\d+(?:\.\d+)?){1,2}\b/i,
    /[\[(]\s*~?-?\d+(?:\.\d+)?\s*,\s*~?-?\d+(?:\.\d+)?\s*,\s*~?-?\d+(?:\.\d+)?\s*[\])]/,
    /\b~?-?\d+(?:\.\d+)?\s*,\s*~?-?\d+(?:\.\d+)?\s*,\s*~?-?\d+(?:\.\d+)?\b/,
    /\b(?:coordinates?|coords?)\s*(?:are|at|:|=)?\s*[\[(]?\s*~?-?\d+(?:\.\d+)?(?:\s*[,\s]\s*~?-?\d+(?:\.\d+)?){1,2}/i,
    /\b(?:at|to|near)\s+[\[(]?\s*~?-?\d+(?:\.\d+)?(?:\s*[,\s]\s*~?-?\d+(?:\.\d+)?){2}\b/i,
];

/**
 * Spoken coordinates leak exact numeric locations to the audience, so TTS
 * swaps them for a vague, in-character reference to a shared meeting place.
 * Keeping a broad pool of phrasings (and destinations) makes the bots sound
 * like people improvising rather than reading the same canned line every time.
 */
export const SPOT_REFERENCE_PHRASES = [
    'Meet me at the spot.',
    "Let's head to the spot.",
    "Let's regroup at the spot.",
    "Let's rally at the spot.",
    "Let's link up at the spot.",
    "Let's get to the secret spot.",
    'Come find me at the usual place.',
    'Meet me where we always meet.',
    "Let's meet at the usual corner.",
    "Let's go to that secret location.",
    'Head to the secret location.',
    'Head over to the secret meeting point.',
    'Come to the secret base.',
    'Meet me at our hideout.',
    'Get to the hideout when you can.',
    'Find me at the hideaway.',
    'Head to the rendezvous point.',
    'Find me at the rendezvous.',
    'Meet me at the old rendezvous.',
    'You know the place — meet me there.',
    'Head to the marked location.',
    'Meet me at the waypoint.',
    'Head to the hidden clearing.',
    "Let's meet at the checkpoint.",
    'Come to the meeting point.',
    'Come find me at the meeting place.',
    'Come to the gathering spot.',
    "Let's meet at the drop-off.",
    'Come to the stash.',
    'Meet me at the landmark.',
    'Meet up at base camp.',
    'Head to that special place.',
    'Meet me at that quiet place.',
    "Let's assemble at the spot.",
];

/**
 * Pick a random vague meeting-place phrase. Accepts an injectable random
 * source so tests (and any deterministic replay) can pin the selection.
 */
export function pickSpotReferencePhrase(randomFn = Math.random) {
    const index = Math.floor(randomFn() * SPOT_REFERENCE_PHRASES.length);
    const safeIndex = Math.min(Math.max(index, 0), SPOT_REFERENCE_PHRASES.length - 1);
    return SPOT_REFERENCE_PHRASES[safeIndex];
}

/**
 * Return only the human-facing portion of a chat response. Minecraft command
 * syntax is operational metadata and must never be sent to text-to-speech.
 */
export function getSpokenChatText(message) {
    const text = String(message || '');
    const commandName = containsCommand(text);
    const commandIndex = commandName ? text.indexOf(commandName) : -1;
    return (commandIndex === -1 ? text : text.substring(0, commandIndex)).trim();
}

/**
 * Coordinates remain available in chat and command arguments, but TTS must
 * never read their numeric values to the audience.
 */
export function getAudibleChatText(message, randomFn = Math.random) {
    const text = String(message || '').trim();
    if (SPOKEN_COORDINATE_PATTERNS.some(pattern => pattern.test(text))) {
        return pickSpotReferencePhrase(randomFn);
    }
    return text;
}

/**
 * Models occasionally ignore the prompt requiring conversational text before
 * a command. Give a human player an audible acknowledgement in that case.
 */
export function getHumanCommandAcknowledgement(response, playerName) {
    if (!containsCommand(String(response || '')) || getSpokenChatText(response)) {
        return null;
    }
    return `Got it, ${playerName}.`;
}

/**
 * Status lines are useful in the server UI, but are not dialogue and should
 * not consume TTS or become part of a contest recording's audio track.
 */
export function isGameOperationalMessage(message) {
    const text = String(message || '').trim();
    return /^\[CODING\b/i.test(text)
        || /^Picking up (?:an? )?item!?$/i.test(text);
}
