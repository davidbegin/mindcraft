// Post-game analysis: every contest game that has ever run, rebuilt from what is
// on disk. Two sources feed it. The journal (contests/journal.jsonl) is the
// append-only record of every event — including, for games played after message
// capture landed, every line each contestant said and where they stood when they
// said it. state.json holds the final snapshot of each contest: the cast, the
// winner, the result table.
//
// On top of the replay it runs an integrity pass (see spawn_detector.js): did the
// winning item come from a placed ore, did anyone start with more than the kit,
// did any generated code try to spawn items. The point is to be able to answer
// "where did that diamond really come from" for any game, past or present.
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import {
    ARENA,
    DIAMOND_RACE_ORES,
    GAME_KITS,
    NETHERITE_RACE_DIAMOND_ORES,
} from './arena_manager.js';
import {
    buildIntegrityReport,
    classifyOreWin,
    resolveOrePositions,
    scanGeneratedCode,
} from './spawn_detector.js';

// Which contests belong in the games archive. Survivor seasons run through the
// same coordinator but have their own viewer, so only contests launched as a
// game session (or otherwise tagged with a game id) show up here.
function isGameContest(contest) {
    return Boolean(contest?.metadata?.gameId)
        || contest?.metadata?.startedFrom === 'game-session-ui';
}

// The placed-ore set for the games where a win item is a mined block. Other
// games have no ore to check against.
const ORE_SETS = Object.freeze({
    diamond_race: DIAMOND_RACE_ORES,
    netherite_race: NETHERITE_RACE_DIAMOND_ORES,
});

function clone(value) {
    return value === null || value === undefined
        ? value
        : JSON.parse(JSON.stringify(value));
}

// A torn final line (a crash mid-append) is skipped rather than throwing away
// every game that came before it.
export function parseJournal(contents) {
    const entries = [];
    for (const line of String(contents ?? '').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            const entry = JSON.parse(trimmed);
            if (typeof entry?.type === 'string') entries.push(entry);
        } catch {
            continue;
        }
    }
    return entries;
}

function groupEntriesByContest(entries) {
    const buckets = new Map();
    for (const entry of entries) {
        const contestId = entry.data?.contestId;
        if (!contestId) continue;
        if (!buckets.has(contestId)) buckets.set(contestId, []);
        buckets.get(contestId).push({ ...entry.data, type: entry.type, at: entry.at ?? null });
    }
    return buckets;
}

function winnerSubmission(contest) {
    for (const winnerId of contest?.winnerIds || []) {
        const submission = contest?.submissions?.[winnerId];
        if (submission) return { winnerId, payload: submission.payload || {} };
    }
    return { winnerId: contest?.winnerIds?.[0] ?? null, payload: {} };
}

// Fold one game's journal + snapshot into the record the viewer reads. The
// `analyze` flag controls whether the (async, disk-touching) generated-code scan
// has already been done and passed in; list() skips it, get() includes it.
export function buildGameRecord({ id, events = [], snapshot = null, codeFindings = [], cheatParticipants = [] }) {
    const ordered = [...events].sort((left, right) => (left.at ?? 0) - (right.at ?? 0));
    const gameId = snapshot?.metadata?.gameId ?? null;
    const gameSession = snapshot?.metadata?.gameSession ?? {};
    const participantMeta = Array.isArray(gameSession.participants) ? gameSession.participants : [];
    const participantIds = snapshot?.participantIds
        ?? [...new Set(participantMeta.map(participant => participant.name))];

    const messages = ordered
        .filter(event => event.type === 'message.said')
        .map(event => ({
            at: event.at,
            participantId: event.participantId,
            text: event.text,
            position: event.position ?? null,
        }));

    // Latest audit per participant wins (a repair re-journals).
    const auditByParticipant = new Map();
    for (const event of ordered) {
        if (event.type === 'inventory.audit' && event.participantId) {
            auditByParticipant.set(event.participantId, {
                participantId: event.participantId,
                expected: event.expected ?? {},
                actual: event.actual ?? {},
                matches: Boolean(event.matches),
                extras: event.extras ?? [],
                missing: event.missing ?? [],
                repaired: Boolean(event.repaired),
            });
        }
    }
    const inventoryAudits = [...auditByParticipant.values()];

    const { winnerId, payload: winnerPayload } = winnerSubmission(snapshot || {});
    const winnerPosition = winnerPayload?.position ?? null;
    const winItem = winnerPayload?.item ?? snapshot?.rules?.winItem ?? null;

    const oreWin = ORE_SETS[gameId] && winnerPosition
        ? classifyOreWin(
            winnerPosition,
            resolveOrePositions(ORE_SETS[gameId], { x: ARENA.centerX, z: ARENA.centerZ })
        )
        : null;

    const integrity = buildIntegrityReport({
        codeFindings,
        inventoryExtras: inventoryAudits.filter(audit => audit.extras?.length),
        cheatParticipants,
        oreWin,
        winnerId,
    });

    const players = participantIds.map(name => {
        const meta = participantMeta.find(participant => participant.name === name) || {};
        return {
            id: name,
            model: meta.model ?? null,
            provider: meta.provider ?? null,
            profileId: meta.profileId ?? null,
            team: meta.team ?? null,
            winner: (snapshot?.winnerIds || []).includes(name),
            messageCount: messages.filter(message => message.participantId === name).length,
            inventoryClean: auditByParticipant.get(name)?.matches ?? null,
        };
    });

    const startedAt = snapshot?.startedAt ?? ordered[0]?.at ?? null;
    const endedAt = snapshot?.completedAt ?? snapshot?.cancelledAt
        ?? (ordered.length ? ordered.at(-1)?.at : null);

    return {
        id,
        gameId,
        title: snapshot?.title ?? gameId ?? 'Contest',
        status: snapshot?.status ?? 'unknown',
        prompt: snapshot?.prompt ?? null,
        startedAt,
        endedAt,
        durationMs: startedAt && endedAt ? endedAt - startedAt : null,
        participantIds,
        players,
        winnerId,
        winnerIds: snapshot?.winnerIds ?? (winnerId ? [winnerId] : []),
        winItem,
        winnerPosition,
        winnerElapsedMs: winnerPayload?.elapsedMs ?? null,
        results: snapshot?.results ?? [],
        messages,
        messageCount: messages.length,
        inventoryAudits,
        allInventoriesClean: inventoryAudits.length
            ? inventoryAudits.every(audit => audit.matches)
            : null,
        integrity,
        timeline: ordered,
        hasMessages: messages.length > 0,
    };
}

// The list screen never needs a game's transcript or its round-by-round detail,
// so summaries drop the heavy fields.
export function summarizeGame(game) {
    return {
        id: game.id,
        gameId: game.gameId,
        title: game.title,
        status: game.status,
        startedAt: game.startedAt,
        endedAt: game.endedAt,
        durationMs: game.durationMs,
        participantIds: game.participantIds,
        winnerId: game.winnerId,
        winItem: game.winItem,
        messageCount: game.messageCount,
        allInventoriesClean: game.allInventoriesClean,
        integrityClean: game.integrity.clean,
        integrityFlagCount: game.integrity.flags.length,
    };
}

export class ContestArchive {
    constructor(options = {}) {
        if (typeof options.root !== 'string' || options.root.trim() === '') {
            throw new TypeError('root must be a non-empty string');
        }
        this.root = path.resolve(options.root);
        this.journalPath = path.join(this.root, 'journal.jsonl');
        this.statePath = path.join(this.root, 'state.json');
        // Where per-bot generated code lives, for the spawn-detection scan.
        this.botsRoot = options.botsRoot ? path.resolve(options.botsRoot) : null;
        this._cache = null;
        this._signature = null;
    }

    async list() {
        const games = await this._read();
        return games.map(summarizeGame);
    }

    async get(contestId) {
        const games = await this._read();
        const game = games.find(entry => entry.id === contestId);
        if (!game) return null;
        // The generated-code scan touches the filesystem, so it is done on
        // demand, only for the game actually being opened.
        const codeFindings = await this._scanActionCode(game);
        const cheatParticipants = await this._detectCheatParticipants(game);
        if (!codeFindings.length && !cheatParticipants.length) return game;
        return {
            ...game,
            integrity: buildIntegrityReport({
                codeFindings,
                inventoryExtras: game.inventoryAudits.filter(audit => audit.extras?.length),
                cheatParticipants,
                oreWin: game.integrity.oreWin,
                winnerId: game.winnerId,
            }),
        };
    }

    async _scanActionCode(game) {
        if (!this.botsRoot || !game.startedAt) return [];
        const windowEnd = game.endedAt ?? Date.now();
        const findings = [];
        for (const name of game.participantIds) {
            const dir = path.join(this.botsRoot, name, 'action-code');
            let files;
            try {
                files = await readdir(dir);
            } catch {
                continue;
            }
            const hits = new Set();
            const hitFiles = [];
            for (const file of files) {
                if (!file.endsWith('.js')) continue;
                const filePath = path.join(dir, file);
                const info = await stat(filePath).catch(() => null);
                // Only code written during this game's window belongs to it.
                if (!info || info.mtimeMs < game.startedAt || info.mtimeMs > windowEnd + 5000) {
                    continue;
                }
                const text = await readFile(filePath, 'utf8').catch(() => '');
                const found = scanGeneratedCode(text);
                if (found.length) {
                    found.forEach(label => hits.add(label));
                    hitFiles.push(file);
                }
            }
            if (hits.size) {
                findings.push({ participantId: name, hits: [...hits], files: hitFiles });
            }
        }
        return findings;
    }

    async _detectCheatParticipants(game) {
        if (!this.botsRoot) return [];
        const cheats = [];
        for (const name of game.participantIds) {
            const profilePath = path.join(this.botsRoot, name, 'last_profile.json');
            try {
                const profile = JSON.parse(await readFile(profilePath, 'utf8'));
                const cheatOn = profile?.cheat === true
                    || profile?.modes?.cheat === true;
                if (cheatOn) cheats.push(name);
            } catch {
                continue;
            }
        }
        return cheats;
    }

    async _read() {
        const signature = await this._diskSignature();
        if (this._cache && signature === this._signature) return this._cache;
        const [entries, state] = await Promise.all([
            this._readJournal(),
            this._readState(),
        ]);
        const buckets = groupEntriesByContest(entries);
        const contests = state?.contests || {};
        const ids = new Set([...buckets.keys(), ...Object.keys(contests)]);
        const games = [];
        for (const id of ids) {
            const snapshot = contests[id] ?? null;
            // A journal-only contest with no snapshot is kept only if it is a
            // game contest; snapshot-bearing ones are filtered the same way.
            if (snapshot && !isGameContest(snapshot)) continue;
            if (!snapshot) {
                const events = buckets.get(id) || [];
                const looksLikeGame = events.some(event => event.type === 'message.said'
                    || event.type === 'inventory.audit');
                if (!looksLikeGame) continue;
            }
            games.push(buildGameRecord({
                id,
                events: buckets.get(id) || [],
                snapshot,
            }));
        }
        games.sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0));
        this._cache = games;
        this._signature = signature;
        return games;
    }

    async _readJournal() {
        try {
            return parseJournal(await readFile(this.journalPath, 'utf8'));
        } catch (error) {
            if (error.code === 'ENOENT') return [];
            throw error;
        }
    }

    async _readState() {
        try {
            return JSON.parse(await readFile(this.statePath, 'utf8'));
        } catch (error) {
            if (error.code === 'ENOENT') return null;
            return null;
        }
    }

    async _diskSignature() {
        const parts = [];
        for (const file of [this.journalPath, this.statePath]) {
            const info = await stat(file).catch(() => null);
            parts.push(info ? `${file}:${info.size}:${info.mtimeMs}` : `${file}:none`);
        }
        return parts.join('|');
    }
}
