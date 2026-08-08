import { containsCommand } from './commands/index.js';

const SPOKEN_COORDINATE_PATTERNS = [
    /\b[xyz]\s*[:=]?\s*~?-?\d+(?:\.\d+)?(?:\s*[,;/]?\s*[xyz]\s*[:=]?\s*~?-?\d+(?:\.\d+)?){1,2}\b/i,
    /[\[(]\s*~?-?\d+(?:\.\d+)?\s*,\s*~?-?\d+(?:\.\d+)?\s*,\s*~?-?\d+(?:\.\d+)?\s*[\])]/,
    /\b~?-?\d+(?:\.\d+)?\s*,\s*~?-?\d+(?:\.\d+)?\s*,\s*~?-?\d+(?:\.\d+)?\b/,
    /\b(?:coordinates?|coords?)\s*(?:are|at|:|=)?\s*[\[(]?\s*~?-?\d+(?:\.\d+)?(?:\s*[,\s]\s*~?-?\d+(?:\.\d+)?){1,2}/i,
    /\b(?:at|to|near)\s+[\[(]?\s*~?-?\d+(?:\.\d+)?(?:\s*[,\s]\s*~?-?\d+(?:\.\d+)?){2}\b/i,
];

/**
 * Earlier prompts told models to say the literal line "Meet me at the spot."
 * Those lines carry no digits, so the coordinate patterns never caught them and
 * the audience heard the same sentence all match. Models still fall back to
 * that memorized phrasing, so treat a bare placeholder "the spot" as a canned
 * line and re-roll it. A descriptive place ("the hidden clearing") is left
 * alone, since that is the varied speech we want.
 */
const CANNED_SPOT_LINE_PATTERN =
    /^(?:meet|come|head|go|let's|lets|we're|were|i'll|ill|see)\b[^.!?]*\b(?:the|our|that) spot\b\s*[.!?]*$/i;

const SPOT_ACTIONS = [
    place => `Meet me at ${place}.`,
    place => `Come meet me at ${place}.`,
    place => `Come find me at ${place}.`,
    place => `Join me at ${place}.`,
    place => `Catch up with me at ${place}.`,
    place => `Link up with me at ${place}.`,
    place => `Rendezvous with me at ${place}.`,
    place => `Wait for me at ${place}.`,
    place => `I'll meet you at ${place}.`,
    place => `I'll be waiting at ${place}.`,
    place => `We're meeting at ${place}.`,
    place => `Head to ${place}.`,
    place => `Head over to ${place}.`,
    place => `Make your way to ${place}.`,
    place => `Get over to ${place}.`,
    place => `Find your way to ${place}.`,
    place => `Set a course for ${place}.`,
    place => `Make for ${place}.`,
    place => `Proceed to ${place}.`,
    place => `Report to ${place}.`,
    place => `Move toward ${place}.`,
    place => `Push toward ${place}.`,
    place => `Travel to ${place}.`,
    place => `Trek over to ${place}.`,
    place => `Swing by ${place}.`,
    place => `Slip away to ${place}.`,
    place => `Sneak over to ${place}.`,
    place => `Fall back to ${place}.`,
    place => `Return to ${place}.`,
    place => `Rally at ${place}.`,
    place => `Regroup at ${place}.`,
    place => `Gather at ${place}.`,
    place => `Assemble at ${place}.`,
    place => `Reconvene at ${place}.`,
    place => `Check in at ${place}.`,
    place => `Converge on ${place}.`,
    place => `Let's meet at ${place}.`,
    place => `Let's head to ${place}.`,
    place => `Let's go to ${place}.`,
    place => `Let's make for ${place}.`,
    place => `Let's move toward ${place}.`,
    place => `Let's regroup at ${place}.`,
    place => `Let's rally at ${place}.`,
    place => `Let's link up at ${place}.`,
    place => `Let's gather at ${place}.`,
    place => `Let's assemble at ${place}.`,
    place => `Let's reconvene at ${place}.`,
    place => `Let's rendezvous at ${place}.`,
    place => `Let's fall back to ${place}.`,
    place => `Let's return to ${place}.`,
    place => `Let's sneak off to ${place}.`,
    place => `Let's slip over to ${place}.`,
    place => `Let's find each other at ${place}.`,
    place => `We should meet at ${place}.`,
    place => `We should regroup at ${place}.`,
    place => `We should rendezvous at ${place}.`,
    place => `We can link up at ${place}.`,
    place => `You can find me at ${place}.`,
    place => `Look for me at ${place}.`,
];

const SPOT_DESCRIPTORS = [
    'secret',
    'hidden',
    'quiet',
    'secluded',
    'concealed',
    'out-of-the-way',
    'sheltered',
    'forgotten',
    'old',
    'familiar',
    'usual',
    'marked',
    'chosen',
    'agreed-upon',
    'safe',
    'secure',
    'private',
    'remote',
    'distant',
    'nearby',
    'back',
    'side',
    'upper',
    'lower',
    'underground',
    'woodland',
];

const SPOT_NOUNS = [
    'spot',
    'place',
    'location',
    'meeting place',
    'meeting point',
    'rendezvous point',
    'rally point',
    'gathering point',
    'waypoint',
    'checkpoint',
    'landmark',
    'hideout',
    'hideaway',
    'base',
    'base camp',
    'camp',
    'outpost',
    'shelter',
    'refuge',
    'retreat',
    'sanctuary',
    'stash',
    'cache',
    'drop-off',
    'crossroads',
    'corner',
    'clearing',
    'grove',
    'lookout',
    'overlook',
    'passage',
    'entrance',
];

const PERSONAL_SPOT_REFERENCES = [
    'our spot',
    'our place',
    'our hideout',
    'our little hideaway',
    'our meeting place',
    'our rendezvous point',
    'our rally point',
    'our waypoint',
    'our checkpoint',
    'our base',
    'our base camp',
    'our shelter',
    'our safe place',
    'our fallback point',
    'the place we picked',
    'the place we discussed',
    'the place we agreed on',
    'the place we know',
    'the place from before',
    'the place we used last time',
    'the place only we know',
    'that special place',
    'that quiet place',
    'that tucked-away place',
    'that place we found',
    'that place we talked about',
    'the usual place',
    'the usual spot',
    'the usual corner',
    'the usual meeting point',
    'the same old spot',
    'the familiar place',
];

const DIRECT_SPOT_REFERENCES = [
    'You know the place — meet me there.',
    'You know the spot — head there now.',
    'You know where to find me.',
    'Meet me where we always meet.',
    'Meet me where we met before.',
    'Meet me where we agreed.',
    'Meet me at the place we discussed.',
    'Go to the place we talked about.',
    'Head where we planned to meet.',
    'Head back to where we started.',
    'Make your way to our agreed location.',
    'Come to the place only we know.',
    'Find me at our little secret.',
    'Same place as before — see you there.',
    'Back to the usual place.',
    'Time to return to our meeting point.',
    "I'll see you at the place we picked.",
    "Let's go to that secret location.",
    "Let's meet somewhere only we know.",
    'Make for the place we chose.',
];

const GENERATED_SPOT_REFERENCES = [
    ...SPOT_NOUNS.map(noun => `the ${noun}`),
    ...SPOT_DESCRIPTORS.flatMap(descriptor =>
        SPOT_NOUNS.map(noun => `the ${descriptor} ${noun}`)
    ),
    ...PERSONAL_SPOT_REFERENCES,
];

/**
 * Spoken coordinates leak exact numeric locations to the audience. This
 * combinatorial catalog creates tens of thousands of natural alternatives
 * while keeping every generated line reviewable through small source lists.
 * Canned "the spot" phrasings are filtered out so a rewrite never produces the
 * very line it is meant to replace.
 */
export const SPOT_REFERENCE_PHRASES = Object.freeze([
    ...new Set([
        ...GENERATED_SPOT_REFERENCES.flatMap(place =>
            SPOT_ACTIONS.map(createPhrase => createPhrase(place))
        ),
        ...DIRECT_SPOT_REFERENCES,
    ]),
].filter(phrase => !CANNED_SPOT_LINE_PATTERN.test(phrase)));

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
    const leaksCoordinates = SPOKEN_COORDINATE_PATTERNS.some(pattern => pattern.test(text));
    if (leaksCoordinates || CANNED_SPOT_LINE_PATTERN.test(text)) {
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
