// The games archive. Every contest game that has ever run, rebuilt on the server
// from contests/journal.jsonl and state.json, read here one game at a time.
//
// The list arrives whole (it is small). A game's transcript, inventory audit and
// integrity findings are fetched only when it is opened, then kept: a finished
// game never changes. A running game is refetched when the games dashboard
// reports movement.
(function () {
    const socket = window.io();
    const TABS = [
        { id: 'overview', label: 'Overview' },
        { id: 'transcript', label: 'Transcript' },
        { id: 'integrity', label: 'Integrity' },
        { id: 'inventory', label: 'Inventory' },
        { id: 'timeline', label: 'Timeline' },
    ];

    let games = [];
    let selectedId = null;
    let tab = 'overview';
    let filter = '';
    let error = null;
    // Which speakers are hidden in the transcript, per game.
    const hiddenSpeakers = new Set();
    const details = new Map();
    const pending = new Set();

    const el = id => document.getElementById(id);

    function esc(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function avatar(name, options) {
        return window.mcAvatar?.html(name, options) ?? '';
    }

    function who(name, scale = 3) {
        if (!name) return '<span class="who">nobody</span>';
        return `<span class="who">${avatar(name, { scale })}<span>${esc(name)}</span></span>`;
    }

    function plural(count, word) {
        return `${count} ${word}${count === 1 ? '' : 's'}`;
    }

    function dateLabel(at) {
        if (!at) return 'unknown date';
        return new Date(at).toLocaleString([], {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
        });
    }

    function timeLabel(at) {
        if (!at) return '';
        return new Date(at).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
    }

    function durationLabel(ms) {
        if (!ms || ms < 0) return '—';
        const seconds = Math.round(ms / 1000);
        if (seconds < 60) return `${seconds}s`;
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
        const hours = Math.floor(minutes / 60);
        return `${hours}h ${minutes % 60}m`;
    }

    function posLabel(position) {
        if (!position) return '';
        const round = value => (Number.isFinite(value) ? Math.round(value) : '?');
        return `${round(position.x)}, ${round(position.y)}, ${round(position.z)}`;
    }

    function gameTitle(game) {
        return game.title || game.gameId || 'Contest';
    }

    function statusChip(status) {
        const known = ['completed', 'running', 'cancelled', 'draft', 'judging'].includes(status)
            ? status
            : '';
        const label = status === 'draft'
            ? 'planning'
            : status === 'judging'
                ? 'judging'
                : status;
        return `<span class="chip ${known}">${esc(label)}</span>`;
    }

    function integrityChip(summary) {
        if (summary.inProgress || ['draft', 'running', 'judging'].includes(summary.status)) {
            return '';
        }
        if (summary.integrityClean) {
            return '<span class="chip clean">clean</span>';
        }
        return `<span class="chip flagged">${esc(plural(summary.integrityFlagCount, 'flag'))}</span>`;
    }

    function seriesChip(game) {
        const series = game?.series;
        if (!series || !(series.bestOf > 1)) return '';
        return `<span class="chip">${esc(formatSeriesSummary(series))}</span>`;
    }

    function formatSeriesSummary(series) {
        if (!series || !(series.bestOf > 1)) return '';
        const scores = series.scores || {};
        const entries = Object.entries(scores)
            .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
        if (entries.length === 2) {
            return `Series ${entries[0][1]}–${entries[1][1]}`;
        }
        return `Bo${series.bestOf}`;
    }

    // —— URL ———————————————————————————————————————————————————————

    function readUrl() {
        const params = new URLSearchParams(window.location.search);
        const wanted = params.get('tab');
        selectedId = params.get('game');
        tab = TABS.some(item => item.id === wanted) ? wanted : 'overview';
    }

    function writeUrl(replace = false) {
        const params = new URLSearchParams();
        if (selectedId) params.set('game', selectedId);
        if (tab !== 'overview') params.set('tab', tab);
        const query = params.toString();
        const url = `/games/archive${query ? `?${query}` : ''}`;
        if (url === `${window.location.pathname}${window.location.search}`) return;
        if (replace) window.history.replaceState({}, '', url);
        else window.history.pushState({}, '', url);
    }

    // —— Game list —————————————————————————————————————————————————

    function matchesFilter(game) {
        const needle = filter.trim().toLowerCase();
        if (!needle) return true;
        return [
            gameTitle(game),
            game.gameId || '',
            game.status,
            game.winnerId || '',
            ...(game.participantIds || []),
        ].join(' ').toLowerCase().includes(needle);
    }

    function renderList() {
        const rows = games.filter(matchesFilter);
        const body = el('gameList');
        if (error) {
            body.innerHTML = `<div class="empty">${esc(error)}</div>`;
            return;
        }
        if (!games.length) {
            body.innerHTML = '<div class="empty">No contest game has been recorded on this server yet.</div>';
            return;
        }
        if (!rows.length) {
            body.innerHTML = '<div class="empty">No game matches that filter.</div>';
            return;
        }
        body.innerHTML = rows.map(game => {
            const meta = [
                dateLabel(game.startedAt),
                plural((game.participantIds || []).length, 'bot'),
                plural(game.messageCount || 0, 'message'),
            ].join(' · ');
            const outcome = game.winnerId
                ? `<div class="game-winner">${who(game.winnerId)} won${game.winItem ? ` (${esc(game.winItem)})` : ''}</div>`
                : `<div class="game-winner none">${esc(
                    game.inProgress || ['draft', 'running', 'judging'].includes(game.status)
                        ? (game.status === 'draft' ? 'planning / provisioning' : 'still playing')
                        : 'no winner'
                )}</div>`;
            return `<button type="button" class="game-row${game.id === selectedId ? ' selected' : ''}" data-game="${esc(game.id)}">
                <span class="game-top">
                    <span class="game-title">${esc(gameTitle(game))}</span>
                    ${statusChip(game.status)}
                    ${seriesChip(game)}
                    ${integrityChip(game)}
                </span>
                <span class="game-meta">${esc(meta)}</span>
                ${outcome}
            </button>`;
        }).join('');
        window.mcAvatar?.paint(body);
    }

    // —— Detail —————————————————————————————————————————————————————

    function renderTabs() {
        const tabs = el('tabs');
        tabs.hidden = !selectedId;
        if (!selectedId) {
            tabs.innerHTML = '';
            return;
        }
        tabs.innerHTML = TABS.map(item =>
            `<button type="button" class="tab${item.id === tab ? ' active' : ''}" data-tab="${item.id}">${esc(item.label)}</button>`
        ).join('');
    }

    function renderDetail() {
        const body = el('detail');
        const summary = games.find(game => game.id === selectedId);
        el('detailTitle').textContent = summary ? gameTitle(summary) : 'Game';
        el('detailCount').textContent = summary
            ? `${summary.status}${summary.endedAt ? ` · ${dateLabel(summary.endedAt)}` : ''}`
            : '';

        if (!selectedId) {
            body.innerHTML = '<div class="empty">Pick a game on the left.</div>';
            return;
        }
        const game = details.get(selectedId);
        if (!game) {
            body.innerHTML = '<div class="empty">Reading the game back from the journal…</div>';
            return;
        }
        const view = {
            overview: renderOverview,
            transcript: renderTranscript,
            integrity: renderIntegrity,
            inventory: renderInventory,
            timeline: renderTimeline,
        }[tab] || renderOverview;
        body.innerHTML = `<div class="detail-body">${view(game)}</div>`;
        window.mcAvatar?.paint(body);
        body.scrollTop = 0;
    }

    function stat(label, value) {
        return `<div class="stat"><span class="label">${esc(label)}</span><span class="value">${esc(value)}</span></div>`;
    }

    function renderOverview(game) {
        const cards = [];

        if (game.winnerId) {
            const where = game.winnerPosition ? posLabel(game.winnerPosition) : null;
            cards.push(`<div class="card winner">
                <div class="winner-row">
                    ${avatar(game.winnerId, { mode: 'body', scale: 3 })}
                    <div>
                        <div class="winner-name">${esc(game.winnerId)}</div>
                        <div class="winner-sub">Won${game.winItem ? ` with a ${esc(game.winItem)}` : ''}${game.winnerElapsedMs ? ` in ${durationLabel(game.winnerElapsedMs)}` : ''}</div>
                        ${where ? `<div class="winner-sub">at ${esc(where)}</div>` : ''}
                    </div>
                </div>
            </div>`);
        } else {
            cards.push(`<div class="card">
                <h3>How it ended</h3>
                <div class="msg-text">${esc(
                    game.inProgress || ['draft', 'running', 'judging'].includes(game.status)
                        ? 'This game is still being played.'
                        : game.status === 'cancelled'
                            ? 'This game was cancelled.'
                            : 'This game ended without a winner.'
                )}</div>
            </div>`);
        }

        const integrity = game.integrity || { clean: true, flags: [] };
        cards.push(`<div class="card ${integrity.clean ? 'ok' : 'alarm'}">
            <h3>Integrity</h3>
            <div class="msg-text">${integrity.clean
                ? 'No spawn or inventory anomalies detected. The win item was mined, not conjured.'
                : `${plural(integrity.flags.length, 'flag')} raised — see the Integrity tab.`}</div>
        </div>`);

        cards.push(`<div class="card">
            <h3>The numbers</h3>
            <div class="stat-grid">
                ${stat('Game', game.gameId || '—')}
                ${stat('Status', game.status)}
                ${stat('Started', dateLabel(game.startedAt))}
                ${stat('Ran for', durationLabel(game.durationMs))}
                ${stat('Bots', (game.participantIds || []).length)}
                ${stat('Messages', game.messageCount || 0)}
                ${game.series?.bestOf > 1
                    ? stat('Series', formatSeriesSummary(game.series))
                    : ''}
                ${stat('Inventories even', game.allInventoriesClean == null ? 'not audited' : game.allInventoriesClean ? 'yes' : 'NO')}
                ${stat('Game id', String(game.id).slice(0, 8))}
            </div>
        </div>`);

        cards.push(`<div class="card">
            <h3>Cast</h3>
            <table class="grid">
                <tr><th>Bot</th><th>Model</th><th>Messages</th><th>Kit clean</th></tr>
                ${(game.players || []).map(player => `<tr>
                    <td>${who(player.id)} ${player.winner ? '<span class="chip clean">winner</span>' : ''}</td>
                    <td class="num">${esc(player.model || '—')}</td>
                    <td class="num">${esc(player.messageCount)}</td>
                    <td class="num ${player.inventoryClean === false ? 'bad' : player.inventoryClean ? 'good' : ''}">${esc(player.inventoryClean == null ? '—' : player.inventoryClean ? 'yes' : 'NO')}</td>
                </tr>`).join('')}
            </table>
        </div>`);

        return cards.join('');
    }

    function renderTranscript(game) {
        if (!game.messages || !game.messages.length) {
            return `<div class="card"><div class="empty">${esc(
                game.inProgress || ['draft', 'running', 'judging'].includes(game.status)
                    ? 'No messages captured yet.'
                    : 'No messages were captured for this game. Message capture only records games played after it was added.'
            )}</div></div>`;
        }
        const speakers = [...new Set(game.messages.map(message => message.participantId))];
        const controls = `<div class="transcript-controls">${speakers.map(name => {
            const off = hiddenSpeakers.has(name);
            return `<button type="button" class="pill-toggle${off ? ' off' : ''}" data-speaker="${esc(name)}">${avatar(name, { scale: 2 })}<span>${esc(name)}</span></button>`;
        }).join('')}</div>`;
        const visible = game.messages.filter(message => !hiddenSpeakers.has(message.participantId));
        const rows = visible.map(message => `<div class="msg">
            <div class="msg-side">
                <span class="msg-who">${avatar(message.participantId, { scale: 2 })}${esc(message.participantId)}</span>
                ${esc(timeLabel(message.at))}
                ${message.position ? `<div class="msg-pos">${esc(posLabel(message.position))}</div>` : ''}
            </div>
            <div class="msg-text">${esc(message.text)}</div>
        </div>`).join('');
        return `<div class="card">
            <h3>Every line said (${esc(plural(game.messages.length, 'message'))})</h3>
            ${controls}
            ${rows || '<div class="empty">All speakers hidden.</div>'}
        </div>`;
    }

    function renderIntegrity(game) {
        const integrity = game.integrity || { clean: true, flags: [], oreWin: null };
        const cards = [];
        cards.push(`<div class="card ${integrity.clean ? 'ok' : 'alarm'}">
            <h3>Verdict</h3>
            <div class="msg-text">${integrity.clean
                ? 'Clean. No agent appears to have spawned items: no spawn commands in generated code, no surplus starting inventory, and the win item was obtained where an ore was placed.'
                : `${plural(integrity.flags.length, 'flag')} raised. Review below.`}</div>
        </div>`);

        if (integrity.flags && integrity.flags.length) {
            cards.push(`<div class="card">
                <h3>Flags</h3>
                ${integrity.flags.map(flag => `<div class="flag">
                    <span class="sev ${flag.severity === 'medium' ? 'medium' : ''}">${esc(flag.severity || 'high')}</span>
                    <div class="body">
                        <strong>${esc(flag.participantId || 'game')}</strong> — ${esc(flag.kind)}
                        <div class="detail">${esc(flag.detail)}${flag.files && flag.files.length ? ` (${esc(flag.files.join(', '))})` : ''}</div>
                    </div>
                </div>`).join('')}
            </div>`);
        }

        const oreWin = integrity.oreWin;
        if (oreWin && oreWin.checked) {
            cards.push(`<div class="card ${oreWin.legitimate ? 'ok' : 'alarm'}">
                <h3>Win item origin</h3>
                <div class="msg-text">${oreWin.legitimate
                    ? `The ${esc(game.winItem || 'win item')} was obtained ${oreWin.distance.toFixed(1)} blocks from a placed ore at ${esc(posLabel(oreWin.nearestOre))} — consistent with mining it.`
                    : `The ${esc(game.winItem || 'win item')} appeared ${oreWin.distance.toFixed(1)} blocks from the nearest placed ore (${esc(posLabel(oreWin.nearestOre))}). No ore was mined there — a possible spawned item.`}</div>
            </div>`);
        }

        return cards.join('');
    }

    function renderInventory(game) {
        if (!game.inventoryAudits || !game.inventoryAudits.length) {
            return `<div class="card"><div class="empty">No inventory audit was recorded for this game.</div></div>`;
        }
        return `<div class="card">
            <h3>Starting inventory audit</h3>
            <div class="msg-text">Every bot should begin with the identical kit and nothing else. A mismatch is re-kitted once at launch; anything left is shown here.</div>
            <table class="grid" style="margin-top:12px">
                <tr><th>Bot</th><th>Even start</th><th>Extras</th><th>Missing</th><th>Re-kitted</th></tr>
                ${game.inventoryAudits.map(audit => `<tr>
                    <td>${who(audit.participantId)}</td>
                    <td class="num ${audit.matches ? 'good' : 'bad'}">${audit.matches ? 'yes' : 'NO'}</td>
                    <td class="num ${audit.extras && audit.extras.length ? 'bad' : ''}">${esc((audit.extras || []).map(item => `${item.count}x ${item.item}`).join(', ') || '—')}</td>
                    <td class="num">${esc((audit.missing || []).map(item => `${item.count}x ${item.item}`).join(', ') || '—')}</td>
                    <td class="num">${audit.repaired ? 'yes' : 'no'}</td>
                </tr>`).join('')}
            </table>
        </div>`;
    }

    function describeEvent(event) {
        switch (event.type) {
            case 'message.said':
                return ['said', `${event.participantId}: “${event.text}”`];
            case 'inventory.audit':
                return ['inventory audit', `${event.participantId}: ${event.matches ? 'even' : 'MISMATCH'}`];
            case 'winner.detected':
                return ['winner', `${event.participantId} — ${event.payload?.item || event.payload?.event || 'won'}`];
            case 'participant.eliminated':
                return ['eliminated', `${event.participantId} (${event.reason || 'out'})`];
            case 'participant.death':
                return ['death', `${event.participantId}`];
            case 'contest.started':
                return ['game started', ''];
            case 'contest.completed':
                return ['game completed', (event.winnerIds || []).join(', ')];
            default: {
                const { type, at, contestId, ...rest } = event;
                return [type, Object.keys(rest).length ? JSON.stringify(rest) : ''];
            }
        }
    }

    function renderTimeline(game) {
        if (!game.timeline || !game.timeline.length) {
            return '<div class="card"><div class="empty">Nothing was journaled for this game.</div></div>';
        }
        return `<div class="card">
            <h3>Everything that happened</h3>
            ${game.timeline.map(event => {
                const [what, detail] = describeEvent(event);
                return `<div class="event">
                    <span class="stamp">${esc(timeLabel(event.at))}</span>
                    <span class="kind">${esc(what)}</span>
                    <span class="detail">${esc(detail)}</span>
                </div>`;
            }).join('')}
        </div>`;
    }

    function render() {
        renderList();
        renderTabs();
        renderDetail();
    }

    // —— Server —————————————————————————————————————————————————————

    function setConnected(connected) {
        const pill = el('msStatus');
        pill.textContent = connected ? 'mindserver online' : 'mindserver offline';
        pill.classList.toggle('online', connected);
        pill.classList.toggle('offline', !connected);
    }

    function loadGames() {
        socket.emit('contest-archive-list', result => {
            if (!result?.success) {
                error = result?.error || 'Could not read the games archive.';
                games = [];
                render();
                return;
            }
            error = null;
            games = result.games || [];
            if (selectedId && !games.some(game => game.id === selectedId)) {
                selectedId = null;
            }
            if (!selectedId) selectedId = games[0]?.id ?? null;
            writeUrl(true);
            render();
            if (selectedId) loadGame(selectedId);
        });
    }

    function loadGame(contestId, { force = false } = {}) {
        if (!contestId) return;
        if (!force && details.has(contestId)) return;
        if (pending.has(contestId)) return;
        pending.add(contestId);
        socket.emit('contest-archive-game', { contestId }, result => {
            pending.delete(contestId);
            if (!result?.success || !result.data) {
                if (contestId === selectedId) {
                    el('detail').innerHTML = `<div class="empty">${esc(result?.error || 'That game could not be read.')}</div>`;
                }
                return;
            }
            details.set(contestId, result.data);
            if (contestId === selectedId) render();
        });
    }

    function selectGame(contestId) {
        if (selectedId === contestId) return;
        selectedId = contestId;
        tab = 'overview';
        hiddenSpeakers.clear();
        writeUrl();
        render();
        loadGame(contestId);
    }

    socket.on('connect', () => {
        setConnected(true);
        loadGames();
    });
    socket.on('disconnect', () => setConnected(false));

    // A running / planning game is part of the archive; refresh when the match
    // moves or a new spoken line lands.
    function refreshInProgressGame(contestId = null) {
        loadGames();
        const targetId = contestId || selectedId;
        const open = games.find(game => game.id === targetId)
            || (targetId === selectedId ? details.get(selectedId) : null);
        const live = open && (
            open.inProgress
            || ['draft', 'running', 'judging'].includes(open.status)
        );
        if (live && targetId === selectedId) {
            details.delete(selectedId);
            loadGame(selectedId, { force: true });
        }
    }

    socket.on('contest-update', () => {
        refreshInProgressGame();
    });

    socket.on('contest-message', payload => {
        if (!payload?.contestId) return;
        const summary = games.find(game => game.id === payload.contestId);
        if (!summary) {
            loadGames();
            return;
        }
        summary.messageCount = (summary.messageCount || 0) + 1;
        renderList();
        if (selectedId === payload.contestId) {
            const game = details.get(selectedId);
            if (game) {
                game.messages = [
                    ...(game.messages || []),
                    {
                        at: payload.at || Date.now(),
                        participantId: payload.participantId,
                        text: payload.text,
                        position: payload.position || null,
                    },
                ];
                game.messageCount = game.messages.length;
                const player = (game.players || []).find(entry => entry.id === payload.participantId);
                if (player) player.messageCount = (player.messageCount || 0) + 1;
                if (tab === 'transcript') {
                    const body = el('detail');
                    const stick = body.scrollHeight - body.scrollTop - body.clientHeight < 64;
                    body.innerHTML = `<div class="detail-body">${renderTranscript(game)}</div>`;
                    window.mcAvatar?.paint(body);
                    if (stick) body.scrollTop = body.scrollHeight;
                } else if (tab === 'overview') {
                    renderDetail();
                }
            } else {
                loadGame(selectedId, { force: true });
            }
        }
    });

    el('gameList').addEventListener('click', domEvent => {
        const row = domEvent.target.closest('[data-game]');
        if (row) selectGame(row.dataset.game);
    });

    el('tabs').addEventListener('click', domEvent => {
        const button = domEvent.target.closest('[data-tab]');
        if (!button) return;
        tab = button.dataset.tab;
        writeUrl();
        render();
    });

    el('detail').addEventListener('click', domEvent => {
        const toggle = domEvent.target.closest('[data-speaker]');
        if (!toggle) return;
        const name = toggle.dataset.speaker;
        if (hiddenSpeakers.has(name)) hiddenSpeakers.delete(name);
        else hiddenSpeakers.add(name);
        renderDetail();
    });

    el('gameFilter').addEventListener('input', domEvent => {
        filter = domEvent.target.value;
        renderList();
    });

    window.addEventListener('popstate', () => {
        readUrl();
        render();
        loadGame(selectedId);
    });

    readUrl();
    render();
})();
