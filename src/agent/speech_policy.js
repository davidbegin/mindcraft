import { containsCommand } from './commands/index.js';

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
