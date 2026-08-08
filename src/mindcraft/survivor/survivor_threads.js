// Private conversations are only ever a stream of room events, and three
// separate readers have to turn that stream back into threads: the live session
// manager, the conversation browser, and the season archive. They all fold the
// same events the same way, so the fold lives here.

export function createThread(event) {
    return {
        roomId: event.roomId,
        round: event.round ?? null,
        phase: event.phase ?? null,
        ownerId: event.ownerId ?? null,
        memberIds: [],
        currentMemberIds: [],
        invitedIds: [],
        pitch: '',
        messages: [],
        messageCount: 0,
        messageCountBySender: {},
        openedAt: event.at ?? null,
        closedAt: null,
        closeReason: null,
        lastMessageAt: null,
        open: true,
    };
}

// Folds one room event into the thread list and returns the thread it touched.
// Limits are how a long-running season keeps its memory bounded; a reader with
// the whole journal in hand leaves them off and keeps everything.
export function applyRoomEvent(threads, event, options = {}) {
    if (!event?.roomId) return null;
    const messageLimit = options.messageLimit ?? Infinity;
    const threadLimit = options.threadLimit ?? Infinity;

    let thread = threads.find(item => item.roomId === event.roomId);
    if (!thread) {
        thread = createThread(event);
        threads.push(thread);
        if (threads.length > threadLimit) {
            threads.splice(0, threads.length - threadLimit);
        }
    }
    // memberIds is the union across the thread's life: someone who talked and
    // then walked out still built a relationship, and their words stay in the
    // transcript.
    for (const memberId of [...(event.memberIds || []), event.memberId]) {
        if (memberId && !thread.memberIds.includes(memberId)) thread.memberIds.push(memberId);
    }
    // Every room event carries the membership as it stands afterwards, which is
    // how a reader knows who is still sitting in an open thread.
    if (Array.isArray(event.memberIds)) thread.currentMemberIds = [...event.memberIds];
    if (event.type === 'room.created') {
        thread.ownerId = event.ownerId ?? thread.ownerId;
        thread.invitedIds = [...(event.invitedIds || [])];
        thread.pitch = event.pitch || '';
    }
    if (event.type === 'room.message' && event.senderId) {
        thread.messages.push({
            id: event.id,
            senderId: event.senderId,
            message: event.message,
            at: event.at,
            round: event.round ?? null,
            phase: event.phase ?? null,
        });
        if (thread.messages.length > messageLimit) thread.messages.shift();
        thread.messageCount += 1;
        thread.messageCountBySender[event.senderId] =
            (thread.messageCountBySender[event.senderId] || 0) + 1;
        thread.lastMessageAt = event.at;
    }
    if (event.type === 'room.closed') {
        thread.open = false;
        thread.closedAt = event.at;
        thread.closeReason = event.reason ?? null;
        thread.currentMemberIds = [];
    }
    return thread;
}

// "I will not meet with you" never becomes a thread, so it would vanish from any
// transcript that only keeps rooms. Silence counts as a refusal too, and only
// talk.resolved knows who never answered.
export function applyRefusalEvent(refusals, event, options = {}) {
    const limit = options.limit ?? Infinity;
    const push = (requesterId, inviteeId, reason) => {
        if (!requesterId || !inviteeId) return;
        const already = refusals.some(item =>
            item.requestId === event.requestId && item.inviteeId === inviteeId
        );
        if (already) return;
        refusals.push({
            requestId: event.requestId ?? null,
            requesterId,
            inviteeId,
            reason,
            at: event.at ?? null,
            round: event.round ?? null,
            phase: event.phase ?? null,
        });
        if (refusals.length > limit) refusals.shift();
    };
    if (event?.type === 'talk.declined') {
        push(event.requesterId, event.inviteeId, event.reason || 'no reason given');
        return true;
    }
    if (event?.type === 'talk.resolved') {
        for (const inviteeId of event.declinerIds || []) {
            push(event.requesterId, inviteeId, 'never answered');
        }
        return true;
    }
    return false;
}
