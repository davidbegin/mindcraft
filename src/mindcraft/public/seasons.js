// The season archive. Every Survivor season that has ever run, rebuilt on the
// server from the journal, read here one season at a time.
//
// The list arrives whole (it is small), and a season's rounds, ballots and
// transcripts are fetched only when it is opened and then kept, since a finished
// season never changes. The live season is in here too and is the one exception:
// it is refetched when the control room reports movement.
(function () {
    const socket = window.io();
    const TABS = [
        { id: 'overview', label: 'Overview' },
        { id: 'rounds', label: 'Rounds' },
        { id: 'cast', label: 'Cast' },
        { id: 'talk', label: 'Private talk' },
        { id: 'timeline', label: 'Timeline' },
    ];

    let seasons = [];
    let selectedId = null;
    let tab = 'overview';
    let filter = '';
    let error = null;
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

    // A name is never just text here: the portrait is how an operator recognises
    // a castaway they watched play.
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

    function phaseLabel(phase) {
        return String(phase || '').replaceAll('_', ' ');
    }

    function ordinal(value) {
        const number = Number(value);
        if (!Number.isFinite(number)) return '—';
        const tens = number % 100;
        if (tens >= 11 && tens <= 13) return `${number}th`;
        return `${number}${['th', 'st', 'nd', 'rd'][number % 10] || 'th'}`;
    }

    function statusChip(status) {
        return `<span class="chip ${esc(status)}">${esc(status)}</span>`;
    }

    function seasonTitle(season) {
        return `Season ${season.seasonNumber}`;
    }

    // —— URL ———————————————————————————————————————————————————————
    //
    // A season and a tab are worth linking to, so they live in the query string
    // rather than in memory only.

    function readUrl() {
        const params = new URLSearchParams(window.location.search);
        const wanted = params.get('tab');
        selectedId = params.get('season');
        tab = TABS.some(item => item.id === wanted) ? wanted : 'overview';
    }

    function writeUrl(replace = false) {
        const params = new URLSearchParams();
        if (selectedId) params.set('season', selectedId);
        if (tab !== 'overview') params.set('tab', tab);
        const query = params.toString();
        const url = `/seasons${query ? `?${query}` : ''}`;
        if (url === `${window.location.pathname}${window.location.search}`) return;
        if (replace) window.history.replaceState({}, '', url);
        else window.history.pushState({}, '', url);
    }

    // —— Season list ———————————————————————————————————————————————

    function matchesFilter(season) {
        const needle = filter.trim().toLowerCase();
        if (!needle) return true;
        return [
            seasonTitle(season),
            season.status,
            season.winnerId || '',
            ...season.participantIds,
        ].join(' ').toLowerCase().includes(needle);
    }

    function renderList() {
        const rows = seasons.filter(matchesFilter);
        const body = el('seasonList');
        if (error) {
            body.innerHTML = `<div class="empty">${esc(error)}</div>`;
            return;
        }
        if (!seasons.length) {
            body.innerHTML = '<div class="empty">No season has ever been run on this server.</div>';
            return;
        }
        if (!rows.length) {
            body.innerHTML = '<div class="empty">No season matches that filter.</div>';
            return;
        }
        body.innerHTML = rows.map(season => {
            const meta = [
                dateLabel(season.startedAt),
                plural(season.castSize, 'castaway'),
                plural(season.roundsPlayed, 'round'),
            ].join(' · ');
            const outcome = season.winnerId
                ? `<div class="season-winner">${who(season.winnerId)} won</div>`
                : `<div class="season-winner none">${esc(season.status === 'running'
                    ? 'still playing'
                    : 'no winner crowned')}</div>`;
            return `<button type="button" class="season-row${season.id === selectedId ? ' selected' : ''}" data-season="${esc(season.id)}">
                <span class="season-top">
                    <span class="season-title">${esc(seasonTitle(season))}</span>
                    ${statusChip(season.status)}
                </span>
                <span class="season-meta">${esc(meta)}</span>
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
        const summary = seasons.find(season => season.id === selectedId);
        el('detailTitle').textContent = summary ? seasonTitle(summary) : 'Season';
        el('detailCount').textContent = summary
            ? `${summary.status}${summary.endedAt ? ` · ended ${dateLabel(summary.endedAt)}` : ''}`
            : '';

        if (!selectedId) {
            body.innerHTML = '<div class="empty">Pick a season on the left.</div>';
            return;
        }
        const season = details.get(selectedId);
        if (!season) {
            body.innerHTML = '<div class="empty">Reading the season back from the journal…</div>';
            return;
        }
        const view = {
            overview: renderOverview,
            rounds: renderRounds,
            cast: renderCast,
            talk: renderTalk,
            timeline: renderTimeline,
        }[tab] || renderOverview;
        body.innerHTML = `<div class="detail-body">${view(season)}</div>`;
        window.mcAvatar?.paint(body);
        body.scrollTop = 0;
    }

    function stat(label, value) {
        return `<div class="stat"><span class="label">${esc(label)}</span><span class="value">${esc(value)}</span></div>`;
    }

    function renderOverview(season) {
        const cards = [];

        if (season.winnerId) {
            const votes = season.finalVote?.counts?.[season.winnerId];
            const total = Object.values(season.finalVote?.counts || {})
                .reduce((sum, count) => sum + count, 0);
            const runnersUp = season.finalistIds.filter(id => id !== season.winnerId);
            cards.push(`<div class="card winner">
                <div class="winner-row">
                    ${avatar(season.winnerId, { mode: 'body', scale: 3 })}
                    <div>
                        <div class="winner-name">${esc(season.winnerId)}</div>
                        <div class="winner-sub">Sole Survivor${votes != null ? ` — ${plural(votes, 'jury vote')} of ${total}` : ''}</div>
                        ${runnersUp.length
                            ? `<div class="winner-sub">beat ${runnersUp.map(id => who(id)).join(' and ')}</div>`
                            : ''}
                    </div>
                </div>
            </div>`);
        } else {
            cards.push(`<div class="card">
                <h3>How it ended</h3>
                <div class="line">${esc(season.status === 'running'
                    ? 'This season is still being played.'
                    : season.status === 'cancelled'
                        ? `Cancelled${season.endReason ? `: ${season.endReason}` : ''}.`
                        : 'This season stopped without ever finishing.')}</div>
            </div>`);
        }

        cards.push(`<div class="card">
            <h3>The numbers</h3>
            <div class="stat-grid">
                ${stat('Status', season.status)}
                ${stat('Started', dateLabel(season.startedAt))}
                ${stat('Ran for', durationLabel(season.durationMs))}
                ${stat('Cast', season.castSize)}
                ${stat('Rounds', season.roundsPlayed)}
                ${stat('Tribal councils', season.councilCount)}
                ${stat('Votes revealed', season.voteCount)}
                ${stat('Merge', season.mergedAtRound ? `after round ${season.mergedAtRound}` : 'never reached')}
                ${stat('Private threads', season.conversations.threadCount)}
                ${stat('Private messages', season.conversations.messageCount)}
                ${stat('Talk refused', season.conversations.talkRefused)}
                ${stat('Season id', season.id.slice(0, 8))}
            </div>
        </div>`);

        const tribeNames = Object.keys(season.tribes || {});
        if (tribeNames.length) {
            cards.push(`<div class="card">
                <h3>Starting tribes</h3>
                ${tribeNames.map(name => `<div class="block">
                    <h4>${esc(name)}</h4>
                    <div class="ballots">${(season.tribes[name] || []).map(id => who(id)).join('')}</div>
                </div>`).join('')}
            </div>`);
        }

        cards.push(`<div class="card">
            <h3>Finishing order</h3>
            ${season.players.some(player => player.placement != null)
                ? `<table class="grid">
                    <tr><th>Place</th><th>Castaway</th><th>Tribe</th><th>Out</th><th>How</th><th>Votes against</th></tr>
                    ${season.players.map(player => `<tr${player.winner ? ' class="winner-row-line"' : ''}>
                        <td class="num">${esc(player.placement != null ? ordinal(player.placement) : '—')}</td>
                        <td>${who(player.id)} ${player.jury ? '<span class="chip jury">jury</span>' : ''}</td>
                        <td class="num">${esc(player.tribe || '—')}</td>
                        <td class="num">${esc(player.eliminatedRound ? `round ${player.eliminatedRound}` : player.winner ? 'won' : 'still in')}</td>
                        <td class="num">${esc(player.eliminationReason || (player.winner ? 'jury vote' : '—'))}</td>
                        <td class="num">${esc(player.votesAgainst)}</td>
                    </tr>`).join('')}
                </table>`
                : '<div class="empty">Nobody was ever voted out.</div>'}
        </div>`);

        return cards.join('');
    }

    function renderVote(vote, season) {
        if (!vote.revealedAt) {
            return `<div class="line">A vote opened${vote.voterIds.length
                ? ` for ${vote.voterIds.map(id => esc(id)).join(', ')}`
                : ''} but was never revealed.</div>`;
        }
        const kindLabel = {
            vote: 'Tribal Council vote',
            revote: 'Revote',
            jury: 'Jury vote',
            'jury-tiebreak': 'Finalist tiebreak',
        }[vote.kind] || vote.kind;
        const entries = Object.entries(vote.counts)
            .sort((left, right) => right[1] - left[1]);
        const top = entries[0]?.[1] ?? 0;
        const jury = vote.kind === 'jury' || vote.kind === 'jury-tiebreak';
        // In a jury vote the most votes wins; everywhere else it sends you home.
        const decisive = id => entries.length && vote.counts[id] === top && !jury;

        return `<div class="block">
            <h4>${esc(kindLabel)}</h4>
            <div class="tally">
                ${entries.map(([id, count]) => `<span class="tally-item${decisive(id) ? ' out' : ''}">
                    ${avatar(id, { scale: 3 })}<span>${esc(id)}</span><span class="count">${count}</span>
                </span>`).join('')}
            </div>
            <div class="ballots">
                ${Object.entries(vote.ballots).map(([voterId, targetId]) => {
                    const auto = vote.autofilledVoterIds.includes(voterId);
                    const reason = vote.reasons?.[voterId];
                    return `<div class="ballot">
                        <div class="cast">
                            ${who(voterId)}<span class="arrow">→</span>
                            <span class="target">${esc(targetId)}</span>
                            ${auto ? '<span class="auto">clock</span>' : ''}
                        </div>
                        ${reason ? `<div class="reason">“${esc(reason)}”</div>` : ''}
                    </div>`;
                }).join('')}
            </div>
            ${jury && season.winnerId
                ? `<div class="line" style="margin-top:8px">Winner: ${who(season.winnerId)}</div>`
                : ''}
        </div>`;
    }

    function renderTiebreak(tiebreak) {
        const lines = [];
        if (tiebreak.tiedIds.length) {
            lines.push(`Tied: ${tiebreak.tiedIds.map(id => esc(id)).join(', ')}.`);
        }
        if (tiebreak.fireMakingIds.length) {
            lines.push(`Fire-making between ${tiebreak.fireMakingIds.map(id => esc(id)).join(' and ')}${tiebreak.fireMakingWinnerId ? `, won by ${esc(tiebreak.fireMakingWinnerId)}` : ''}.`);
        }
        if (tiebreak.rockDrawerIds.length) {
            lines.push(`Rocks drawn by ${tiebreak.rockDrawerIds.map(id => esc(id)).join(', ')}.`);
        }
        if (tiebreak.resolvedBy) {
            lines.push(`Settled by ${esc(tiebreak.resolvedBy)}${tiebreak.eliminatedId ? `, sending ${esc(tiebreak.eliminatedId)} home` : ''}.`);
        }
        if (!lines.length) return '';
        return `<div class="block"><h4>Deadlock</h4>${lines.map(line => `<div class="line">${line}</div>`).join('')}</div>`;
    }

    function renderRounds(season) {
        if (!season.rounds.length) {
            return '<div class="empty">This season never got past its opening event.</div>';
        }
        return season.rounds.map(round => {
            const parts = [];
            const challenge = round.challenge;
            if (challenge) {
                const outcome = challenge.winnerId
                    ? `${who(challenge.winnerId)} took individual immunity`
                    : challenge.winningTribe
                        ? `<strong>${esc(challenge.winningTribe)}</strong> won immunity, <strong>${esc(challenge.councilTribe || 'the other tribe')}</strong> went to council`
                        : 'no result recorded';
                parts.push(`<div class="block">
                    <h4>Challenge</h4>
                    <div class="line"><strong>${esc(challenge.id || 'unnamed')}</strong> (${esc(challenge.mode || 'unknown')}) — ${outcome}</div>
                    ${challenge.standings?.length
                        ? `<div class="line">${challenge.standings.map(item =>
                            `${esc(item.tribe || item.playerId || '?')}: ${esc(
                                typeof item.score === 'number' ? item.score.toFixed(2) : item.score
                            )}${item.detail ? ` (${esc(item.detail)})` : ''}`
                        ).join(' · ')}</div>`
                        : ''}
                </div>`);
            }

            const council = round.council;
            if (council) {
                parts.push(`<div class="block">
                    <h4>${esc(council.kind === 'final' ? 'Final Tribal Council' : 'Tribal Council')}</h4>
                    <div class="line">${plural(council.attendeeIds.length, 'attendee')}${council.targetIds.length
                        ? ` · on the block: ${council.targetIds.map(id => esc(id)).join(', ')}`
                        : ''}</div>
                    ${council.questions.map(question => `<div class="qa">
                        <div class="prompt">“${esc(question.prompt)}” <span class="thread-meta">— ${esc(question.askedBy)}</span></div>
                        ${question.answers.map(answer =>
                            `<div class="answer"><strong>${esc(answer.playerId)}:</strong> ${esc(answer.answer)}</div>`
                        ).join('')}
                    </div>`).join('')}
                </div>`);
            }

            for (const vote of round.votes) parts.push(renderVote(vote, season));
            if (round.tiebreak) parts.push(renderTiebreak(round.tiebreak));

            for (const boot of round.eliminations) {
                parts.push(`<div class="boot-line">
                    ${avatar(boot.playerId, { mode: 'body', scale: 2 })}
                    <span>
                        <span class="name">${esc(boot.playerId)}</span> went home ${esc(ordinal(boot.placement))}
                        <span class="why">— ${esc(boot.reason)}${boot.joinsJury ? ', joins the jury' : ''}</span>
                    </span>
                </div>`);
            }

            if (round.mergedHere) {
                parts.push('<div class="block"><span class="chip merge">tribes merged</span></div>');
            }

            return `<div class="card">
                <div class="round-head">
                    <h3>Round ${round.round}</h3>
                    <span class="chip">${round.merged ? 'post-merge' : 'tribal'}</span>
                    <span class="when">${esc(dateLabel(round.startedAt))} · ${esc(durationLabel((round.endedAt ?? 0) - (round.startedAt ?? 0)))}</span>
                </div>
                ${parts.join('') || '<div class="line">Nothing was recorded for this round.</div>'}
            </div>`;
        }).join('');
    }

    function renderCast(season) {
        if (!season.players.length) {
            return '<div class="empty">No cast was ever recorded for this season.</div>';
        }
        return `<div class="card">
            <h3>Everyone who played</h3>
            <table class="grid">
                <tr>
                    <th>Place</th><th>Castaway</th><th>Tribe</th>
                    <th>Votes against</th><th>Votes cast</th><th>Individual immunity</th>
                    <th>Tribe wins</th><th>Councils</th><th>Jury votes</th>
                    <th>Said</th><th>Heard</th><th>Talked to</th>
                </tr>
                ${season.players.map(player => `<tr${player.winner ? ' class="winner-row-line"' : ''}>
                    <td class="num">${esc(player.placement != null ? ordinal(player.placement) : '—')}</td>
                    <td>${who(player.id)}</td>
                    <td class="num">${esc(player.tribe || '—')}</td>
                    <td class="num">${esc(player.votesAgainst)}</td>
                    <td class="num">${esc(player.votesCast)}</td>
                    <td class="num">${esc(player.individualImmunityWins)}</td>
                    <td class="num">${esc(player.tribeChallengeWins)}</td>
                    <td class="num">${esc(player.councilsAttended)}</td>
                    <td class="num">${esc(player.juryVotesReceived)}</td>
                    <td class="num">${esc(player.spokenCount)}</td>
                    <td class="num">${esc(player.heardCount)}</td>
                    <td class="num">${esc(player.partnerIds.length)}</td>
                </tr>`).join('')}
            </table>
        </div>`;
    }

    function renderTalk(season) {
        const { threads, refusals } = season.conversations;
        const cards = [];
        if (refusals.length) {
            cards.push(`<div class="card">
                <h3>Doors that stayed shut</h3>
                ${refusals.map(item => `<div class="line">
                    <strong>${esc(item.inviteeId)}</strong> would not meet with ${esc(item.requesterId)} — ${esc(item.reason)}
                    <span class="thread-meta">round ${esc(item.round ?? '?')}</span>
                </div>`).join('')}
            </div>`);
        }
        if (!threads.length) {
            cards.push('<div class="empty">Nobody spoke in private this season.</div>');
            return cards.join('');
        }
        const ordered = [...threads].sort((left, right) =>
            (left.openedAt ?? 0) - (right.openedAt ?? 0));
        cards.push(ordered.map(thread => `<div class="thread">
            <div class="thread-head">
                <span class="with">${thread.memberIds.map(id => who(id)).join('')}</span>
                <span class="chip">round ${esc(thread.round ?? '?')}</span>
            </div>
            <div class="thread-meta">${esc(`opened by ${thread.ownerId || 'unknown'} at ${dateLabel(thread.openedAt)} · ${plural(thread.messageCount, 'message')}${thread.closeReason ? ` · closed (${thread.closeReason})` : ''}`)}</div>
            ${thread.pitch ? `<div class="pitch">“${esc(thread.pitch)}”</div>` : ''}
            ${thread.messages.map(message => `<div class="msg">
                <div class="msg-side">
                    <span class="msg-who">${esc(message.senderId)}</span>
                    ${esc(timeLabel(message.at))}
                </div>
                <div class="msg-text">${esc(message.message)}</div>
            </div>`).join('')}
        </div>`).join(''));
        return cards.join('');
    }

    // Every event type the game can journal, said in a sentence. Anything not
    // named here still shows up, as its type and payload, so a new event never
    // silently disappears from the record.
    function describeEvent(event) {
        const names = ids => (ids || []).join(', ');
        switch (event.type) {
            case 'season.started':
                return ['Season started', names(event.participantIds)];
            case 'challenge.started':
                return ['Challenge started', `${event.id} (${event.mode})`];
            case 'challenge.completed':
                return ['Challenge won', event.winnerId
                    ? `${event.winnerId} takes immunity`
                    : `${event.winningTribe} wins, ${event.councilTribe} goes to council`];
            case 'council.opened':
                return ['Council opened', `${names(event.attendeeIds)} — on the block: ${names(event.targetIds)}`];
            case 'council.question':
                return ['Question', `${event.askedBy || 'host'}: “${event.prompt}”`];
            case 'council.answer':
                return ['Answer', `${event.playerId}: “${event.answer}”`];
            case 'vote.started':
                return ['Voting opened', `${names(event.voters)} may vote for ${names(event.targets)}`];
            case 'ballots.autofilled':
                return ['Clock filled ballots', (event.ballots || [])
                    .map(item => `${item.voterId} → ${item.targetId}`).join(', ')];
            case 'vote.revealed':
                return ['Votes revealed', Object.entries(event.counts || {})
                    .map(([id, count]) => `${id}: ${count}`).join(', ')];
            case 'revote.started':
                return ['Revote', `tied: ${names(event.tiedIds)}`];
            case 'deadlock.started':
                return ['Deadlock', `${names(event.tiedIds)} tied; ${names(event.decisionMakerIds)} decide`];
            case 'rocks.drawn':
                return ['Rocks drawn', `${event.eliminatedId} drew the purple rock`];
            case 'fire_making.started':
                return ['Fire-making', names(event.contestantIds)];
            case 'fire_making.completed':
                return ['Fire made', `${event.winnerId} beat ${event.eliminatedId}`];
            case 'player.eliminated':
                return ['Voted out', `${event.playerId} finishes ${ordinal(event.placement)} (${event.reason})${event.joinsJury ? ', joins the jury' : ''}`];
            case 'tribes.merged':
                return ['Merge', names(event.playerIds)];
            case 'finalists.reached':
                return ['Finalists', names(event.finalistIds)];
            case 'jury.vote.started':
                return ['Jury vote', `${names(event.jurorIds)} judge ${names(event.finalistIds)}`];
            case 'jury.vote.revealed':
                return ['Jury vote revealed', Object.entries(event.counts || {})
                    .map(([id, count]) => `${id}: ${count}`).join(', ')];
            case 'jury.tiebreak.started':
                return ['Jury deadlock', `${event.voterId} decides between ${names(event.finalistIds)}`];
            case 'jury.tiebreak.revealed':
                return ['Tiebreak decided', `${event.voterId} chose ${event.winnerId}`];
            case 'season.completed':
                return ['Season won', `${event.winnerId} is the Sole Survivor`];
            case 'season.cancelled':
                return ['Season cancelled', event.reason || ''];
            default: {
                const { type, at, round, ...rest } = event;
                return [type, Object.keys(rest).length ? JSON.stringify(rest) : ''];
            }
        }
    }

    function renderTimeline(season) {
        if (!season.timeline.length) return '<div class="empty">Nothing was journaled for this season.</div>';
        return `<div class="card">
            <h3>Everything that happened</h3>
            ${season.timeline.map(event => {
                const [what, detail] = describeEvent(event);
                return `<div class="event">
                    <span class="stamp">${esc(timeLabel(event.at))}</span>
                    <span class="round">${esc(event.round ? `round ${event.round}` : '')}</span>
                    <span class="what">
                        <strong>${esc(what)}</strong>
                        ${detail ? `<div class="detail">${esc(detail)}</div>` : ''}
                    </span>
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

    function loadSeasons() {
        socket.emit('survivor-seasons', result => {
            if (!result?.success) {
                error = result?.error || 'Could not read the season archive.';
                seasons = [];
                render();
                return;
            }
            error = null;
            seasons = result.seasons || [];
            // A season the URL asked for that no longer exists should not leave
            // the page stuck on an empty detail pane.
            if (selectedId && !seasons.some(season => season.id === selectedId)) {
                selectedId = null;
            }
            if (!selectedId) selectedId = seasons[0]?.id ?? null;
            writeUrl(true);
            render();
            if (selectedId) loadSeason(selectedId);
        });
    }

    function loadSeason(seasonId, { force = false } = {}) {
        if (!seasonId) return;
        if (!force && details.has(seasonId)) return;
        if (pending.has(seasonId)) return;
        pending.add(seasonId);
        socket.emit('survivor-season', { seasonId }, result => {
            pending.delete(seasonId);
            if (!result?.success || !result.data) {
                if (seasonId === selectedId) {
                    el('detail').innerHTML = `<div class="empty">${esc(result?.error || 'That season could not be read.')}</div>`;
                }
                return;
            }
            details.set(seasonId, result.data);
            if (seasonId === selectedId) render();
        });
    }

    function selectSeason(seasonId) {
        if (selectedId === seasonId) return;
        selectedId = seasonId;
        tab = 'overview';
        writeUrl();
        render();
        loadSeason(seasonId);
    }

    socket.on('connect', () => {
        setConnected(true);
        loadSeasons();
    });
    socket.on('disconnect', () => setConnected(false));

    // A running season is part of the archive, and the control room is the only
    // thing that knows it moved.
    socket.on('survivor-update', view => {
        const live = view?.game?.id ?? view?.id ?? null;
        // No view at all means a season just ended or was cleared, and how it
        // ended is exactly what this page is for.
        if (!live || !seasons.some(season => season.id === live)) {
            loadSeasons();
            return;
        }
        details.delete(live);
        if (live === selectedId) loadSeason(live, { force: true });
    });

    el('seasonList').addEventListener('click', domEvent => {
        const row = domEvent.target.closest('[data-season]');
        if (row) selectSeason(row.dataset.season);
    });

    el('tabs').addEventListener('click', domEvent => {
        const button = domEvent.target.closest('[data-tab]');
        if (!button) return;
        tab = button.dataset.tab;
        writeUrl();
        render();
    });

    el('seasonFilter').addEventListener('input', domEvent => {
        filter = domEvent.target.value;
        renderList();
    });

    window.addEventListener('popstate', () => {
        readUrl();
        render();
        loadSeason(selectedId);
    });

    readUrl();
    render();
})();
