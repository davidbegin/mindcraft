import { containsCommand } from './commands/index.js';

const SPOKEN_COORDINATE_PATTERNS = [
    /\b[xyz]\s*[:=]?\s*~?-?\d+(?:\.\d+)?(?:\s*[,;/]?\s*[xyz]\s*[:=]?\s*~?-?\d+(?:\.\d+)?){1,2}\b/i,
    /[\[(]\s*~?-?\d+(?:\.\d+)?\s*,\s*~?-?\d+(?:\.\d+)?\s*,\s*~?-?\d+(?:\.\d+)?\s*[\])]/,
    /\b~?-?\d+(?:\.\d+)?\s*,\s*~?-?\d+(?:\.\d+)?\s*,\s*~?-?\d+(?:\.\d+)?\b/,
    /\b(?:coordinates?|coords?)\s*(?:are|at|:|=)?\s*[\[(]?\s*~?-?\d+(?:\.\d+)?(?:\s*[,\s]\s*~?-?\d+(?:\.\d+)?){1,2}/i,
    /\b(?:at|to|near)\s+[\[(]?\s*~?-?\d+(?:\.\d+)?(?:\s*[,\s]\s*~?-?\d+(?:\.\d+)?){2}\b/i,
];

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
export function getAudibleChatText(message) {
    const text = String(message || '').trim();
    if (SPOKEN_COORDINATE_PATTERNS.some(pattern => pattern.test(text))) {
        return 'Meet me at the spot.';
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
