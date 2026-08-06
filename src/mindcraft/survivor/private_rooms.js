import { randomUUID } from 'node:crypto';

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function assertId(value, label) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(`${label} must be a non-empty string`);
    }
}

export class PrivateRoomRegistry {
    constructor(options = {}) {
        this.idFactory = options.idFactory || randomUUID;
        this.onEvent = options.onEvent || (() => {});
        this.rooms = new Map();
        this.roomByMember = new Map();
    }

    view() {
        return [...this.rooms.values()].map(room => clone(room));
    }

    roomFor(memberId) {
        const roomId = this.roomByMember.get(memberId);
        return roomId ? clone(this.rooms.get(roomId)) : null;
    }

    create(ownerId, inviteeIds, eligibleIds, pitch = '') {
        assertId(ownerId, 'ownerId');
        if (!Array.isArray(inviteeIds)) throw new TypeError('inviteeIds must be an array');
        const eligible = new Set(eligibleIds || []);
        if (!eligible.has(ownerId)) throw new Error(`${ownerId} cannot create a private room`);
        const invitees = [...new Set(inviteeIds.map(id => String(id).trim()))]
            .filter(id => id && id !== ownerId);
        if (invitees.length === 0) throw new Error('Invite at least one other player');
        const invalid = invitees.filter(id => !eligible.has(id));
        if (invalid.length > 0) throw new Error(`Players cannot be invited: ${invalid.join(', ')}`);
        if (String(pitch || '').length > 2000) {
            throw new Error('Private room pitch must be 2000 characters or fewer');
        }

        this.leave(ownerId);
        const room = {
            id: this.idFactory(),
            ownerId,
            memberIds: [ownerId],
            invitedIds: invitees,
            pitch: String(pitch || ''),
            messages: [],
            createdAt: Date.now(),
        };
        this.rooms.set(room.id, room);
        this.roomByMember.set(ownerId, room.id);
        this._event('room.created', {
            roomId: room.id,
            ownerId,
            memberIds: room.memberIds,
            invitedIds: room.invitedIds,
            pitch: room.pitch,
        });
        return clone(room);
    }

    join(roomId, memberId, eligibleIds) {
        const room = this._requireRoom(roomId);
        const eligible = new Set(eligibleIds || []);
        if (!eligible.has(memberId)) throw new Error(`${memberId} cannot join private rooms`);
        if (!room.invitedIds.includes(memberId) && room.ownerId !== memberId) {
            throw new Error(`${memberId} was not invited to ${roomId}`);
        }
        this.leave(memberId);
        if (!room.memberIds.includes(memberId)) room.memberIds.push(memberId);
        room.invitedIds = room.invitedIds.filter(id => id !== memberId);
        this.roomByMember.set(memberId, room.id);
        this._event('room.joined', {
            roomId: room.id,
            memberId,
            memberIds: room.memberIds,
        });
        return clone(room);
    }

    leave(memberId) {
        const roomId = this.roomByMember.get(memberId);
        if (!roomId) return null;
        const room = this.rooms.get(roomId);
        this.roomByMember.delete(memberId);
        if (!room) return null;
        room.memberIds = room.memberIds.filter(id => id !== memberId);
        this._event('room.left', {
            roomId,
            memberId,
            memberIds: room.memberIds,
        });
        if (room.memberIds.length < 2) {
            this.close(roomId, 'not-enough-members');
            return null;
        }
        if (room.ownerId === memberId) room.ownerId = room.memberIds[0];
        return clone(room);
    }

    send(memberId, message) {
        assertId(message, 'message');
        if (message.length > 2000) {
            throw new Error('Private message must be 2000 characters or fewer');
        }
        const roomId = this.roomByMember.get(memberId);
        if (!roomId) throw new Error(`${memberId} is not in a private room`);
        const room = this._requireRoom(roomId);
        const entry = {
            id: this.idFactory(),
            roomId,
            senderId: memberId,
            memberIds: [...room.memberIds],
            message: message.trim(),
            at: Date.now(),
        };
        room.messages.push(entry);
        if (room.messages.length > 200) room.messages.shift();
        this._event('room.message', entry);
        return clone(entry);
    }

    close(roomId, reason = 'closed') {
        const room = this.rooms.get(roomId);
        if (!room) return false;
        for (const memberId of room.memberIds) this.roomByMember.delete(memberId);
        this.rooms.delete(roomId);
        this._event('room.closed', {
            roomId,
            reason,
            memberIds: room.memberIds,
        });
        return true;
    }

    closeAll(reason = 'phase-ended') {
        for (const roomId of [...this.rooms.keys()]) this.close(roomId, reason);
    }

    removePlayer(playerId, reason = 'player-eliminated') {
        this.leave(playerId);
        for (const room of this.rooms.values()) {
            room.invitedIds = room.invitedIds.filter(id => id !== playerId);
        }
        this._event('room.player-removed', { playerId, reason });
    }

    _requireRoom(roomId) {
        const room = this.rooms.get(roomId);
        if (!room) throw new Error(`Unknown private room: ${roomId}`);
        return room;
    }

    _event(type, data) {
        this.onEvent({ type, ...clone(data) });
    }
}
