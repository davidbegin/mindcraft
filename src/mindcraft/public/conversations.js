// The private conversation browser. Pick a castaway on the left, see every
// thread they are part of in the middle, read the words on the right.
//
// The server sends the whole transcript once (survivor-transcripts) and then
// only deltas (survivor-secret-event), so this page holds the threads itself and
// derives every count from them. That keeps it correct after a reconnect without
// re-downloading a season's worth of chatter on every message.
(function () {
    const socket = window.io();
    // Room ids are UUIDs, so this can never collide with a real thread.
    const ALL_THREADS = 'all-threads';

    let season = null;
    let roster = [];
    let threads = [];
    let refusals = [];
    let selectedId = null;
    let selectedThreadId = ALL_THREADS;
    let rosterFilter = '';

    const el = id => document.getElementById(id);

    function esc(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function phaseLabel(phase) {
        return String(phase || '').replaceAll('_', ' ') || 'unknown';
    }

    function timeLabel(at) {
        if (!at) return '';
        return new Date(at).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
    }

    function plural(count, word) {
        return `${count} ${word}${count === 1 ? '' : 's'}`;
    }

    // —— Derived views —————————————————————————————————————————————

    function threadsFor(playerId) {
        return threads
            .filter(thread => thread.memberIds.includes(playerId))
            .sort((left, right) => activityAt(right) - activityAt(left));
    }

    function activityAt(thread) {
        return thread.lastMessageAt ?? thread.openedAt ?? 0;
    }

    function partnersOf(thread, playerId) {
        return thread.memberIds.filter(id => id !== playerId);
    }

    function threadLabel(thread, playerId) {
        const others = partnersOf(thread, playerId);
        return others.length ? others.join(', ') : 'nobody else joined';
    }

    function statsFor(playerId) {
        const own = threadsFor(playerId);
        const spoken = own.reduce(
            (total, thread) => total + (thread.messageCountBySender[playerId] || 0),
            0
        );
        return {
            threads: own,
            spoken,
            heard: own.reduce((total, thread) => total + thread.messageCount, 0) - spoken,
            open: own.filter(thread => thread.open).length,
            partners: new Set(own.flatMap(thread => partnersOf(thread, playerId))).size,
            lastAt: own.length ? activityAt(own[0]) : 0,
        };
    }

    function refusalsFor(playerId) {
        return refusals.filter(item =>
            item.requesterId === playerId || item.inviteeId === playerId
        );
    }

    // —— Render ————————————————————————————————————————————————————

    function render() {
        const hasSeason = Boolean(season && roster.length);
        el('panes').hidden = !hasSeason;
        el('seasonBar').hidden = !hasSeason;
        el('pageEmpty').hidden = hasSeason;
        if (!hasSeason) return;
        renderSeasonBar();
        renderRoster();
        renderThreads();
        renderTranscript();
    }

    function renderSeasonBar() {
        el('sbRound').textContent = season.round ?? '—';
        el('sbPhase').textContent = phaseLabel(season.phase);
        el('sbThreads').textContent = threads.length;
        el('sbOpen').textContent = threads.filter(thread => thread.open).length;
        el('sbMessages').textContent = threads.reduce(
            (total, thread) => total + thread.messageCount,
            0
        );
    }

    function renderRoster() {
        const needle = rosterFilter.trim().toLowerCase();
        const rows = roster
            .map(player => ({ player, stats: statsFor(player.id) }))
            .filter(row => !needle || row.player.id.toLowerCase().includes(needle))
            .sort((left, right) =>
                right.stats.lastAt - left.stats.lastAt
                || left.player.id.localeCompare(right.player.id));

        el('roster').innerHTML = rows.length
            ? rows.map(({ player, stats }) => {
                const chips = [];
                if (stats.open) chips.push('<span class="chip open">talking</span>');
                if (!player.active && player.jury) chips.push('<span class="chip jury">jury</span>');
                else if (!player.active) chips.push('<span class="chip gone">out</span>');
                else if (player.tribe) chips.push(`<span class="chip tribe">${esc(player.tribe)}</span>`);
                const sub = stats.threads.length
                    ? `${plural(stats.threads.length, 'thread')} · ${stats.spoken} said · ${stats.heard} heard`
                    : 'no private talk yet';
                return `<button type="button" class="cast-row${player.id === selectedId ? ' selected' : ''}${player.active ? '' : ' out'}" data-player="${esc(player.id)}">
                    <span class="cast-main">
                        <span class="cast-name">${esc(player.id)}</span>
                        <span class="cast-sub">${esc(sub)}</span>
                    </span>
                    ${chips.join('')}
                </button>`;
            }).join('')
            : '<div class="empty">Nobody matches that filter.</div>';
    }

    function renderThreads() {
        if (!selectedId) {
            el('threadsTitle').textContent = 'Conversations';
            el('threadsCount').textContent = '';
            el('threads').innerHTML = '<div class="empty">Pick a castaway to read their private talk.</div>';
            return;
        }
        const stats = statsFor(selectedId);
        el('threadsTitle').textContent = selectedId;
        el('threadsCount').textContent = stats.threads.length
            ? `${plural(stats.partners, 'partner')} · ${plural(stats.threads.length, 'thread')}`
            : '';

        const sections = [];
        if (stats.threads.length > 1) {
            sections.push(`<button type="button" class="thread-row${selectedThreadId === ALL_THREADS ? ' selected' : ''}" data-thread="${esc(ALL_THREADS)}">
                <span class="thread-top"><span class="thread-with">Everything, in order</span></span>
                <span class="thread-meta">${esc(`${stats.spoken} said · ${stats.heard} heard · across ${plural(stats.threads.length, 'thread')}`)}</span>
            </button>`);
        }

        sections.push(...stats.threads.map(thread => {
            const last = thread.messages.at(-1);
            const meta = [
                thread.open ? 'open now' : `closed${thread.closeReason ? ` (${thread.closeReason})` : ''}`,
                `round ${thread.round ?? '?'} ${phaseLabel(thread.phase)}`,
                plural(thread.messageCount, 'message'),
            ].join(' · ');
            return `<button type="button" class="thread-row${selectedThreadId === thread.roomId ? ' selected' : ''}" data-thread="${esc(thread.roomId)}">
                <span class="thread-top">
                    <span class="thread-with">${esc(threadLabel(thread, selectedId))}</span>
                    ${thread.open ? '<span class="chip open">live</span>' : ''}
                </span>
                <span class="thread-meta">${esc(meta)}</span>
                ${last ? `<span class="thread-snippet">${esc(`${last.senderId}: ${last.message}`)}</span>` : ''}
            </button>`;
        }));

        if (!stats.threads.length) {
            sections.push(`<div class="empty">${esc(selectedId)} has not been in a private conversation yet.</div>`);
        }

        const refused = refusalsFor(selectedId);
        if (refused.length) {
            sections.push(`<div class="pane-section">
                <h3>Doors that stayed shut</h3>
                ${refused.map(item => (item.requesterId === selectedId
                    ? `<div class="refusal"><strong>${esc(item.inviteeId)}</strong> would not meet with them — ${esc(item.reason)}</div>`
                    : `<div class="refusal">They turned down <strong>${esc(item.requesterId)}</strong> — ${esc(item.reason)}</div>`
                )).join('')}
            </div>`);
        }

        el('threads').innerHTML = sections.join('');
    }

    function renderTranscript() {
        const body = el('transcript');
        // Someone scrolled back to read history should stay where they are; a
        // reader pinned to the bottom should follow the conversation live.
        const pinned = body.scrollHeight - body.scrollTop - body.clientHeight < 60;

        if (!selectedId) {
            el('transcriptTitle').textContent = 'Transcript';
            el('transcriptCount').textContent = '';
            body.innerHTML = '<div class="empty">Nothing selected.</div>';
            return;
        }

        const stats = statsFor(selectedId);
        const thread = stats.threads.find(item => item.roomId === selectedThreadId);
        const shown = thread ? [thread] : stats.threads;
        const messages = shown
            .flatMap(item => item.messages.map(message => ({ message, thread: item })))
            .sort((left, right) => left.message.at - right.message.at);

        el('transcriptTitle').textContent = thread
            ? `${selectedId} & ${threadLabel(thread, selectedId)}`
            : `${selectedId} — everything`;
        el('transcriptCount').textContent = plural(messages.length, 'message');

        const banner = thread
            ? `<div class="thread-banner">
                <div><strong>${esc(thread.memberIds.join(', '))}</strong>
                    <span class="chip ${thread.open ? 'open' : 'gone'}">${thread.open ? 'open' : 'closed'}</span></div>
                <div class="thread-meta">${esc(`opened by ${thread.ownerId || 'unknown'} in round ${thread.round ?? '?'} ${phaseLabel(thread.phase)} at ${timeLabel(thread.openedAt)}`)}</div>
                ${thread.pitch ? `<div class="pitch">“${esc(thread.pitch)}”</div>` : ''}
            </div>`
            : '';

        body.innerHTML = `<div class="transcript-body">${banner}${messages.length
            ? messages.map(({ message, thread: owner }) => {
                const mine = message.senderId === selectedId;
                const audience = owner.memberIds.filter(id => id !== message.senderId);
                return `<div class="msg${mine ? ' mine' : ''}">
                    <div class="msg-side">
                        <span class="msg-who">${esc(message.senderId)}</span>
                        ${esc(timeLabel(message.at))}<br>r${esc(message.round ?? '?')} ${esc(phaseLabel(message.phase))}
                    </div>
                    <div>
                        <div class="msg-text">${esc(message.message)}</div>
                        <div class="msg-audience">${esc(`to ${audience.join(', ') || 'nobody'}`)}</div>
                    </div>
                </div>`;
            }).join('')
            : '<div class="empty">No words spoken in here yet.</div>'}</div>`;

        if (pinned) body.scrollTop = body.scrollHeight;
    }

    // —— Selection —————————————————————————————————————————————————

    function selectPlayer(playerId) {
        selectedId = playerId;
        selectedThreadId = ALL_THREADS;
        render();
    }

    function defaultSelection() {
        if (selectedId && roster.some(player => player.id === selectedId)) return;
        const busiest = roster
            .map(player => ({ id: player.id, stats: statsFor(player.id) }))
            .sort((left, right) => right.stats.lastAt - left.stats.lastAt)[0];
        selectedId = busiest?.id ?? null;
        selectedThreadId = ALL_THREADS;
    }

    // —— Incremental updates ———————————————————————————————————————

    function threadFor(event) {
        let thread = threads.find(item => item.roomId === event.roomId);
        if (thread) return thread;
        // A room we never saw open: the page connected mid-conversation, so start
        // the record from whatever this event tells us.
        thread = {
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
        threads.push(thread);
        return thread;
    }

    function noteRefusal(requestId, requesterId, inviteeId, reason, event) {
        if (!requesterId || !inviteeId) return;
        const already = refusals.some(item =>
            item.requestId === requestId && item.inviteeId === inviteeId
        );
        if (already) return;
        refusals.push({
            requestId: requestId ?? null,
            requesterId,
            inviteeId,
            reason,
            at: event.at ?? null,
            round: event.round ?? null,
            phase: event.phase ?? null,
        });
    }

    function applySecretEvent(event) {
        if (!event?.type) return false;
        if (event.type === 'talk.declined') {
            noteRefusal(
                event.requestId,
                event.requesterId,
                event.inviteeId,
                event.reason || 'no reason given',
                event
            );
            return true;
        }
        if (event.type === 'talk.resolved') {
            for (const inviteeId of event.declinerIds || []) {
                noteRefusal(event.requestId, event.requesterId, inviteeId, 'never answered', event);
            }
            return true;
        }
        if (!event.roomId) return false;

        const thread = threadFor(event);
        for (const memberId of [...(event.memberIds || []), event.memberId]) {
            if (memberId && !thread.memberIds.includes(memberId)) thread.memberIds.push(memberId);
        }
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
        return true;
    }

    // —— Server —————————————————————————————————————————————————————

    function setConnected(connected) {
        const pill = el('msStatus');
        pill.textContent = connected ? 'mindserver online' : 'mindserver offline';
        pill.classList.toggle('online', connected);
        pill.classList.toggle('offline', !connected);
    }

    function loadTranscripts() {
        socket.emit('survivor-transcripts', result => {
            if (!result?.success || !result.data) {
                season = null;
                roster = [];
                threads = [];
                refusals = [];
                el('pageEmptyText').textContent = result?.error
                    || 'No Survivor season is running, so there are no private conversations yet.';
                render();
                return;
            }
            const data = result.data;
            season = {
                seasonId: data.seasonId,
                status: data.status,
                round: data.round,
                phase: data.phase,
            };
            roster = data.players || [];
            threads = data.threads || [];
            refusals = data.refusals || [];
            defaultSelection();
            render();
        });
    }

    socket.on('connect', () => {
        setConnected(true);
        loadTranscripts();
    });
    socket.on('disconnect', () => setConnected(false));

    socket.on('survivor-secret-event', event => {
        if (!season) {
            loadTranscripts();
            return;
        }
        if (applySecretEvent(event)) render();
    });

    // The season view is the only place the roster's tribe and jury status live,
    // and a new season means the transcripts we are holding belong to the past.
    socket.on('survivor-update', view => {
        if (!view?.game) {
            if (season) loadTranscripts();
            return;
        }
        if (season && view.id !== season.seasonId) {
            loadTranscripts();
            return;
        }
        if (!season) {
            loadTranscripts();
            return;
        }
        season.round = view.game.round;
        season.phase = view.game.phase;
        season.status = view.status;
        roster = (view.game.participantIds || []).map(id => {
            const player = view.game.players?.[id] || {};
            return {
                id,
                tribe: player.tribe ?? null,
                active: Boolean(player.active),
                jury: Boolean(player.jury),
                placement: player.placement ?? null,
            };
        });
        defaultSelection();
        render();
    });

    el('roster').addEventListener('click', domEvent => {
        const row = domEvent.target.closest('[data-player]');
        if (row) selectPlayer(row.dataset.player);
    });

    el('threads').addEventListener('click', domEvent => {
        const row = domEvent.target.closest('[data-thread]');
        if (!row) return;
        selectedThreadId = row.dataset.thread;
        render();
    });

    el('rosterFilter').addEventListener('input', domEvent => {
        rosterFilter = domEvent.target.value;
        renderRoster();
    });

    render();
})();
