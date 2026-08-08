import { randomUUID } from 'node:crypto';

// Strategy talk is a negotiation before it is a conversation. A bot asks a
// specific set of players to step aside; each of them independently accepts or
// refuses; the room only opens for the ones who said yes. Refusals are the
// interesting half — "I'm not talking to you" is a move, and being frozen out is
// information the frozen-out bot has to act on.

export const MAX_CONVERSATION_INVITEES = 4;
export const MAX_PITCH_LENGTH = 2000;
export const MAX_DECLINE_REASON_LENGTH = 300;

function clone(value) {
    return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function assertId(value, label) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(`${label} must be a non-empty string`);
    }
    return value.trim();
}

export class ConversationRequestRegistry {
    constructor(options = {}) {
        this.idFactory = options.idFactory || randomUUID;
        this.onEvent = options.onEvent || (() => {});
        this.clock = options.clock || (() => Date.now());
        this.requestTtlMs = options.requestTtlMs ?? 30_000;
        this.maxInvitees = options.maxInvitees ?? MAX_CONVERSATION_INVITEES;
        // A bot who was just turned down should read the room instead of asking
        // the same player again on the next tick.
        this.declineCooldownMs = options.declineCooldownMs ?? 45_000;
        this.requests = new Map();
        this.declinedAt = new Map();
    }

    view() {
        return [...this.requests.values()].map(request => clone(request));
    }

    pending() {
        return this.view().filter(request => request.status === 'pending');
    }

    // Everything a single bot is allowed to see: its own asks and the asks
    // pointed at it. Requests between other players stay invisible.
    pendingFor(playerId) {
        return this.pending().filter(request =>
            request.requesterId === playerId || request.inviteeIds.includes(playerId)
        );
    }

    get(requestId) {
        const request = this.requests.get(requestId);
        return request ? clone(request) : null;
    }

    open(requesterId, inviteeIds, eligibleIds, options = {}) {
        const requester = assertId(requesterId, 'requesterId');
        const eligible = new Set(eligibleIds || []);
        if (!eligible.has(requester)) {
            throw new Error(`${requester} cannot start a private conversation right now`);
        }
        if (!Array.isArray(inviteeIds)) throw new TypeError('inviteeIds must be an array');
        const invitees = [...new Set(inviteeIds.map(id => String(id ?? '').trim()))]
            .filter(id => id && id !== requester);
        if (invitees.length === 0) throw new Error('Name at least one other player to talk to');
        if (invitees.length > this.maxInvitees) {
            throw new Error(`You can pull aside at most ${this.maxInvitees} players at once`);
        }
        const unavailable = invitees.filter(id => !eligible.has(id));
        if (unavailable.length > 0) {
            throw new Error(`Not available to talk: ${unavailable.join(', ')}`);
        }
        const pitch = String(options.pitch ?? '');
        if (pitch.length > MAX_PITCH_LENGTH) {
            throw new Error(`An opening pitch must be ${MAX_PITCH_LENGTH} characters or fewer`);
        }

        const now = this.clock();
        const existing = this.pending().find(request => request.requesterId === requester);
        if (existing) {
            throw new Error(`You are already waiting on an answer from ${existing.inviteeIds.join(', ')}`);
        }
        const cooling = invitees.filter(id => this._coolingDown(requester, id, now));
        if (cooling.length > 0) {
            throw new Error(`${cooling.join(', ')} already turned you down. Give it time.`);
        }

        const request = {
            id: this.idFactory(),
            requesterId: requester,
            inviteeIds: invitees,
            pitch,
            responses: {},
            status: 'pending',
            roomId: null,
            createdAt: now,
            expiresAt: now + this.requestTtlMs,
            resolvedAt: null,
        };
        this.requests.set(request.id, request);
        this._event('talk.requested', request);
        return clone(request);
    }

    // Returns the request plus whether this answer settled it, so the caller
    // knows when to actually open the room.
    respond(requestId, inviteeId, accepted, reason = '') {
        const request = this._requirePending(requestId);
        const invitee = assertId(inviteeId, 'inviteeId');
        if (!request.inviteeIds.includes(invitee)) {
            throw new Error(`${invitee} was not asked to this conversation`);
        }
        if (request.responses[invitee]) {
            throw new Error(`${invitee} already answered this request`);
        }
        const trimmed = String(reason ?? '').trim();
        if (trimmed.length > MAX_DECLINE_REASON_LENGTH) {
            throw new Error(`A reason must be ${MAX_DECLINE_REASON_LENGTH} characters or fewer`);
        }
        const now = this.clock();
        request.responses[invitee] = {
            accepted: Boolean(accepted),
            reason: trimmed,
            at: now,
        };
        if (accepted) {
            this._event('talk.accepted', {
                requestId: request.id,
                requesterId: request.requesterId,
                inviteeId: invitee,
            });
        } else {
            this.declinedAt.set(`${request.requesterId}\u0000${invitee}`, now);
            this._event('talk.declined', {
                requestId: request.id,
                requesterId: request.requesterId,
                inviteeId: invitee,
                reason: trimmed,
            });
        }
        const outstanding = request.inviteeIds.filter(id => !request.responses[id]);
        return {
            request: clone(request),
            settled: outstanding.length === 0,
            outstandingIds: outstanding,
            accepterIds: this._accepterIds(request),
        };
    }

    // Called once everyone has answered (or the clock ran out). Splitting this
    // from respond() lets a partially-answered request still open a room at the
    // deadline for whoever did say yes.
    resolve(requestId, roomId = null) {
        const request = this._requirePending(requestId);
        const accepterIds = this._accepterIds(request);
        request.status = accepterIds.length > 0 ? 'accepted' : 'declined';
        request.roomId = accepterIds.length > 0 ? roomId : null;
        request.resolvedAt = this.clock();
        this._event('talk.resolved', {
            requestId: request.id,
            requesterId: request.requesterId,
            status: request.status,
            accepterIds,
            declinerIds: request.inviteeIds.filter(id => !request.responses[id]?.accepted),
            roomId: request.roomId,
        });
        return { request: clone(request), accepterIds };
    }

    // Requests that ran out of time. A silent invitee counts as a refusal: the
    // show cannot wait on a bot that never answered.
    dueRequests(now = this.clock()) {
        return this.pending().filter(request => now >= request.expiresAt);
    }

    cancel(requestId, reason = 'cancelled') {
        const request = this.requests.get(requestId);
        if (!request || request.status !== 'pending') return null;
        request.status = 'cancelled';
        request.resolvedAt = this.clock();
        this._event('talk.cancelled', {
            requestId: request.id,
            requesterId: request.requesterId,
            reason,
        });
        return clone(request);
    }

    cancelAll(reason = 'phase-ended') {
        for (const request of this.pending()) this.cancel(request.id, reason);
        this.requests.clear();
        this.declinedAt.clear();
    }

    removePlayer(playerId, reason = 'player-eliminated') {
        for (const request of this.pending()) {
            if (request.requesterId === playerId || request.inviteeIds.includes(playerId)) {
                this.cancel(request.id, reason);
            }
        }
    }

    _accepterIds(request) {
        return request.inviteeIds.filter(id => request.responses[id]?.accepted);
    }

    _coolingDown(requesterId, inviteeId, now) {
        const at = this.declinedAt.get(`${requesterId}\u0000${inviteeId}`);
        return at != null && now - at < this.declineCooldownMs;
    }

    _requirePending(requestId) {
        const request = this.requests.get(requestId);
        if (!request) throw new Error(`Unknown conversation request: ${requestId}`);
        if (request.status !== 'pending') {
            throw new Error(`Conversation request ${requestId} is already ${request.status}`);
        }
        return request;
    }

    _event(type, data) {
        this.onEvent({ type, ...clone(data) });
    }
}
