// Survivor control room. Everything here is driven by three server messages:
// the survivor-status ack on load, survivor-update on every state change, and
// survivor-secret-event for private alliance chatter.
(function () {
    const socket = window.io();
    const CHEAP_TEST_PROFILE_ID = 'gpt-5-6-luna-instant';
    const CHEAP_TEST_SCENARIO_ID = 'four_player';

    let state = null;          // SurvivorSessionManager.view()
    let games = [];            // contest game presets, for challenge names
    let scenarios = [];
    let preset = null;
    let join = null;
    let profiles = [];
    let agents = [];
    let secretEvents = [];
    let activeContest = null;
    let deckDraft = null;      // staged reorder, null while in sync with server
    let standingsSort = { key: 'default', descending: true };
    let gameSetup = null;
    let askTargets = new Set();   // who the next question goes to
    let pickerRoster = '';        // rebuild the picker only when the cast changes

    // Jeff's standard openers. These are the questions that make bots commit to a
    // position in public, which is what the rest of the cast then votes on.
    const TRIBAL_QUESTIONS = [
        'Somebody is going home tonight. Why should it not be you?',
        'Who here do you trust the least right now, and say it to their face.',
        'Is there an alliance running this tribe? Name it.',
        'What is the biggest lie that has been told since the last vote?',
        'Who is playing the best game, and why is it not you?',
        'If you go home tonight, who do you blame?',
        'You are all voting for someone who may end up choosing the winner. Does that change your vote?',
    ];

    const FINAL_QUESTIONS = [
        'Name the single move you made that got you to this seat.',
        'Which juror did you personally cut, and what do you want to say to them?',
        'Jurors: what do you still need to hear tonight before you vote?',
        'Why do you deserve this over the person sitting next to you?',
        'Jurors: who controlled this game, and who just survived it?',
    ];

    const el = id => document.getElementById(id);

    function esc(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function names(list) {
        return (list || []).join(', ');
    }

    function gameTitle(gameId) {
        return games.find(item => item.id === gameId)?.title || gameId || 'unknown';
    }

    function phaseLabel(phase) {
        return String(phase || '').replaceAll('_', ' ');
    }

    function formatCountdown(deadlineAt) {
        if (!deadlineAt) return '—';
        const remaining = Math.max(0, deadlineAt - Date.now());
        const totalSeconds = Math.floor(remaining / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        return `${minutes}:${String(totalSeconds % 60).padStart(2, '0')}`;
    }

    // A phase with no deadline is waiting on the host, not broken.
    function phaseClockLabel() {
        if (state?.paused) return 'paused';
        if (!state?.phaseDeadlineAt) return 'you decide';
        return formatCountdown(state.phaseDeadlineAt);
    }

    function setStatus(message, isError = false) {
        const node = el('statusMsg');
        node.textContent = message || '';
        node.classList.toggle('error', Boolean(isError && message));
    }

    function currentGame() {
        return state?.game || null;
    }

    function activeIds(game) {
        return (game.participantIds || []).filter(id => game.players?.[id]?.active);
    }

    // —— Server calls ——————————————————————————————————————————————

    function control(action, payload = {}) {
        socket.timeout(30_000).emit('survivor-control', { action, ...payload }, (err, result) => {
            if (err || !result?.success) {
                setStatus(err ? 'Survivor control timed out' : result?.error || 'Survivor control failed', true);
                return;
            }
            setStatus('');
            applyState(result.data);
        });
    }

    function loadStatus() {
        socket.emit('survivor-status', result => {
            if (!result?.success) {
                setStatus(result?.error || 'Survivor is not available on this MindServer', true);
                return;
            }
            preset = result.preset || preset;
            join = result.join || join;
            if (Array.isArray(result.games) && result.games.length) games = result.games;
            if (Array.isArray(result.scenarios) && result.scenarios.length) {
                scenarios = result.scenarios;
                renderScenarios();
            }
            if (Array.isArray(result.secretEvents)) secretEvents = result.secretEvents;
            renderJoin();
            renderDeckAddOptions();
            applyState(result.data);
        });
    }

    function loadProfiles() {
        socket.emit('list-profiles', result => {
            profiles = result?.success ? result.profiles || [] : [];
            updateStartButton();
        });
    }

    // —— Rendering ————————————————————————————————————————————————

    function applyState(next) {
        state = next || null;
        // A save that lands leaves the draft matching the server, so drop it and
        // follow the server again.
        if (deckDraft && !deckDirty()) deckDraft = null;
        render();
    }

    function render() {
        const game = currentGame();
        el('seasonHud').hidden = !game;
        el('controlGrid').hidden = !game;
        el('startPanel').hidden = Boolean(game && game.status === 'running');
        renderReadiness();
        updateStartButton();
        if (!game) {
            renderSecretFeed();
            return;
        }
        renderHud(game);
        renderCouncil(game);
        renderTribes(game);
        renderStandings();
        renderBootOrder(game);
        renderVoteBoard(game);
        renderDeck();
        renderChallengeHistory(game);
        renderTimeline(game);
        renderActiveChallenge();
        renderRelationships();
        renderTalkRequests();
        renderRooms();
        renderSecretFeed();
        renderDiagnostics();
    }

    // —— Tribal Council console ————————————————————————————————————

    function council() {
        const value = state?.council;
        return value?.open ? value : null;
    }

    function renderCouncil(game) {
        const live = council();
        el('councilRoom').hidden = !live;
        if (!live) {
            pickerRoster = '';
            return;
        }
        const isFinal = live.kind === 'final';
        el('councilTitle').textContent = isFinal
            ? 'Final Tribal Council'
            : `Tribal Council — round ${live.round}`;
        el('councilWho').textContent = isFinal
            ? `Finalists ${names(game.finalistIds)} · jury ${names(game.juryIds)}`
            : `${live.askableIds.length} at council · vulnerable: ${names(game.eligibleTargetIds) || 'nobody'}`;
        el('councilCloseBtn').textContent = isFinal
            ? 'Close council and open the jury vote'
            : 'Close council and open voting';
        renderTargetPicker(live, game);
        renderPresetQuestions(isFinal);
        renderTranscript(live);
    }

    function renderTargetPicker(live, game) {
        // Default to asking the whole council; the operator narrows from there.
        const roster = live.askableIds.join('|');
        if (roster !== pickerRoster) {
            pickerRoster = roster;
            askTargets = new Set(live.askableIds);
        }
        for (const id of [...askTargets]) {
            if (!live.askableIds.includes(id)) askTargets.delete(id);
        }
        el('targetPicker').innerHTML = live.askableIds.map(id => {
            const juror = game.players?.[id]?.jury;
            const on = askTargets.has(id);
            return `<label class="target-chip ${on ? 'on' : ''} ${juror ? 'jury' : ''}">
                <input type="checkbox" data-target="${esc(id)}" ${on ? 'checked' : ''}>
                ${esc(id)}${juror ? ' (juror)' : ''}
            </label>`;
        }).join('');
        for (const box of el('targetPicker').querySelectorAll('input[data-target]')) {
            box.addEventListener('change', () => {
                if (box.checked) askTargets.add(box.dataset.target);
                else askTargets.delete(box.dataset.target);
                renderTargetPicker(live, game);
            });
        }
        el('askBtn').disabled = askTargets.size === 0;
    }

    function renderPresetQuestions(isFinal) {
        const questions = isFinal ? FINAL_QUESTIONS : TRIBAL_QUESTIONS;
        el('presetQuestions').innerHTML = questions.map(question =>
            `<button type="button" data-question="${esc(question)}">${esc(question)}</button>`
        ).join('');
        for (const button of el('presetQuestions').querySelectorAll('[data-question]')) {
            button.addEventListener('click', () => {
                el('questionText').value = button.dataset.question;
                el('questionText').focus();
            });
        }
    }

    function renderTranscript(live) {
        const box = el('councilTranscript');
        if (!live.questions.length) {
            box.innerHTML = '<div class="empty">Ask the first question. Nothing is on the record yet.</div>';
            return;
        }
        box.innerHTML = [...live.questions].reverse().map(question => {
            const answers = question.targetIds.map(id => {
                const answer = question.answers.find(item => item.playerId === id);
                return answer
                    ? `<div class="qa-answer">
                        <span class="speaker">${esc(id)}</span>
                        <span class="said">${esc(answer.answer)}</span>
                    </div>`
                    : `<div class="qa-answer waiting">
                        <span class="speaker">${esc(id)}</span>
                        <span class="said">still thinking…
                            <button type="button" class="btn btn-ghost btn-icon"
                                data-speak-for="${esc(id)}" data-question="${esc(question.id)}"
                                title="Put an answer on the record for a bot that is stuck">speak for them</button>
                        </span>
                    </div>`;
            }).join('');
            return `<div class="qa-block">
                <div class="prompt">${esc(question.prompt)}</div>
                <div class="asked-of">asked of ${esc(names(question.targetIds))}
                    · ${question.answers.length}/${question.targetIds.length} answered</div>
                ${answers}
            </div>`;
        }).join('');
        for (const button of box.querySelectorAll('[data-speak-for]')) {
            button.addEventListener('click', () => {
                const playerId = button.dataset.speakFor;
                const answer = window.prompt(`Answer on ${playerId}'s behalf:`);
                if (!answer) return;
                control('council-answer', {
                    playerId,
                    questionId: button.dataset.question,
                    answer,
                });
            });
        }
    }

    function askQuestion() {
        const prompt = el('questionText').value.trim();
        if (!prompt) {
            setStatus('Type a question first', true);
            return;
        }
        if (askTargets.size === 0) {
            setStatus('Pick at least one player to ask', true);
            return;
        }
        control('council-question', { prompt, targetIds: [...askTargets] });
        el('questionText').value = '';
    }

    // —— Conversation requests ————————————————————————————————————

    function renderTalkRequests() {
        const requests = (state?.conversationRequests || [])
            .filter(request => request.status === 'pending' || request.status === 'declined');
        const box = el('talkRequests');
        if (!requests.length) {
            box.innerHTML = '';
            return;
        }
        box.innerHTML = [...requests].reverse().slice(0, 8).map(request => {
            const answers = request.inviteeIds.map(id => {
                const response = request.responses?.[id];
                if (!response) return `<span class="answer-chip waiting">${esc(id)} · thinking</span>`;
                return response.accepted
                    ? `<span class="answer-chip yes">${esc(id)} · yes</span>`
                    : `<span class="answer-chip no">${esc(id)} · no${response.reason ? ` · ${esc(response.reason)}` : ''}</span>`;
            }).join('');
            return `<div class="talk-card ${esc(request.status)}">
                <div class="ask"><strong>${esc(request.requesterId)}</strong>
                    asked ${esc(names(request.inviteeIds))} to talk</div>
                ${request.pitch ? `<div class="pitch">“${esc(request.pitch)}”</div>` : ''}
                <div class="answers">${answers}</div>
            </div>`;
        }).join('');
    }

    // —— Diagnostics ——————————————————————————————————————————————

    function renderDiagnostics() {
        const problems = state?.problems || [];
        const failure = state?.lastFailure || null;
        el('problemCount').textContent = problems.length ? `${problems.length} issues` : 'all clear';

        const game = currentGame();
        el('agentGrid').innerHTML = (game?.participantIds || []).map(id => {
            const agent = agents.find(item => item.name === id);
            const player = game.players?.[id] || {};
            const connected = Boolean(agent?.in_game);
            const relevant = player.active || player.jury;
            const tone = !relevant ? '' : connected ? 'immune' : 'danger';
            return `<span class="chip ${tone}" title="${connected ? 'in game' : 'not in game'}">
                ${esc(id)}${relevant ? (connected ? '' : ' ⚠') : ' ·'}
            </span>`;
        }).join('');

        const rows = [];
        if (failure) {
            rows.push(`<div class="problem-row">
                <span class="stage">${esc(failure.stage)}</span>
                <span>${esc(failure.error)}<span class="detail"> ${esc(failure.at || '')}</span></span>
            </div>`);
        }
        for (const problem of [...problems].reverse()) {
            rows.push(`<div class="problem-row">
                <span class="stage">${esc(problem.stage)}</span>
                <span>${esc(problem.message)}
                    ${problem.detail ? `<span class="detail">${esc(JSON.stringify(problem.detail))}</span>` : ''}
                </span>
            </div>`);
        }
        el('problems').innerHTML = rows.length
            ? rows.join('')
            : '<div class="empty">No delivery failures or errors this season.</div>';
    }

    function copyDiagnostics() {
        const payload = JSON.stringify({
            phase: currentGame()?.phase,
            round: currentGame()?.round,
            paused: state?.paused,
            phaseDeadlineAt: state?.phaseDeadlineAt,
            council: state?.council,
            conversationRequests: state?.conversationRequests,
            problems: state?.problems,
            lastFailure: state?.lastFailure,
            readiness: state?.readiness,
        }, null, 2);
        navigator.clipboard.writeText(payload)
            .then(() => setStatus('Diagnostics copied to the clipboard.'))
            .catch(() => setStatus('Could not reach the clipboard.', true));
    }

    function renderReadiness() {
        const readiness = state?.readiness;
        if (!readiness) return;
        const pending = names(readiness.pending);
        setStatus(
            `Survivor ${readiness.stage}: ${readiness.ready}/${readiness.total} bots in game`
            + (pending ? ` · waiting on ${pending}` : '')
        );
    }

    // Mirrors advancePhase() on the server so the button says what pressing it
    // will actually do rather than a vague "advance".
    const ADVANCE_LABELS = {
        strategy: 'Open Tribal Council',
        tribal_council: 'Close council, open voting',
        voting: 'Read the votes',
        revote: 'Read the revote',
        jury_voting: 'Read the jury vote',
        finalist_tiebreak: 'Read the tiebreak vote',
        deadlock: 'Settle the deadlock',
        jury_questioning: 'Send the jury to vote',
        fire_making: 'Resolve fire-making',
    };

    function renderHud(game) {
        const remaining = activeIds(game);
        el('hudRound').textContent = game.status === 'completed'
            ? 'Season complete'
            : `Round ${game.round}`;
        el('hudPhase').textContent = phaseLabel(game.phase);
        el('hudRemaining').textContent = `${remaining.length} of ${game.participantIds.length}`;
        el('hudCountdown').textContent = phaseClockLabel();
        el('hudImmunity').textContent = names(game.immunityIds) || '—';
        el('hudJury').textContent = game.juryIds?.length ? String(game.juryIds.length) : '—';
        el('hudPaused').hidden = !state.paused;

        const inChallenge = game.phase === 'challenge';
        const running = game.status === 'running';
        el('pauseBtn').textContent = state.paused ? 'Resume' : 'Pause';
        el('pauseBtn').disabled = inChallenge || !running;
        const advanceLabel = ADVANCE_LABELS[game.phase];
        el('advanceBtn').textContent = advanceLabel || 'Advance phase';
        el('advanceBtn').disabled = inChallenge || !running || !advanceLabel;
        el('cancelSeasonBtn').disabled = !running;
        el('watchLiveLink').href = `/live.html?session=survivor-${encodeURIComponent(game.id)}`;
    }

    function renderTribes(game) {
        const box = el('tribeChips');
        if (game.merged) {
            const remaining = activeIds(game);
            box.innerHTML = `<span class="chip"><strong>Merged</strong> — ${esc(names(remaining) || 'nobody left')}</span>`;
            return;
        }
        box.innerHTML = (game.tribeNames || []).map(tribe => {
            const members = (game.tribes?.[tribe] || []).filter(id => game.players?.[id]?.active);
            const council = game.councilTribe === tribe;
            return `<span class="chip ${council ? 'danger' : ''}">
                <strong>${esc(tribe)}</strong>${council ? ' (council)' : ''}: ${esc(names(members) || 'none')}
            </span>`;
        }).join('');
    }

    const STANDINGS_COLUMNS = [
        { key: 'id', label: 'Player', numeric: false },
        { key: 'tribe', label: 'Tribe', numeric: false },
        { key: 'status', label: 'Status', numeric: false },
        { key: 'immunityWins', label: 'Imm', numeric: true, title: 'Immunity wins' },
        { key: 'votesReceived', label: 'Vs', numeric: true, title: 'Votes received' },
        { key: 'votesCast', label: 'Cast', numeric: true, title: 'Votes cast' },
        { key: 'juryVotesReceived', label: 'Jury', numeric: true, title: 'Jury votes received' },
        { key: 'placement', label: 'Place', numeric: true },
    ];

    function sortedStandings() {
        const rows = [...(state?.standings || [])];
        if (standingsSort.key === 'default') return rows;
        const column = STANDINGS_COLUMNS.find(item => item.key === standingsSort.key);
        const direction = standingsSort.descending ? -1 : 1;
        rows.sort((left, right) => {
            const a = left[standingsSort.key];
            const b = right[standingsSort.key];
            if (a == null && b == null) return 0;
            if (a == null) return 1;
            if (b == null) return -1;
            if (column?.numeric) return (a - b) * direction;
            return String(a).localeCompare(String(b)) * direction;
        });
        return rows;
    }

    function renderStandings() {
        const rows = sortedStandings();
        el('standingsCount').textContent = `${rows.length} castaways`;
        el('standingsHead').innerHTML = STANDINGS_COLUMNS.map(column => `
            <th data-sort="${column.key}" class="${standingsSort.key === column.key ? 'sorted' : ''}"
                title="${esc(column.title || column.label)}">${esc(column.label)}</th>
        `).join('');
        el('standingsBody').innerHTML = rows.map(row => `
            <tr class="${row.active ? '' : 'out'} ${row.status === 'winner' ? 'winner' : ''}">
                <td><strong>${esc(row.id)}</strong></td>
                <td>${esc(row.tribe || '—')}</td>
                <td><span class="pill ${esc(row.status)}">${esc(phaseLabel(row.status))}</span></td>
                <td class="num">${row.immunityWins || '·'}</td>
                <td class="num">${row.votesReceived || '·'}</td>
                <td class="num">${row.votesCast || '·'}</td>
                <td class="num">${row.juryVotesReceived || '·'}</td>
                <td class="num">${row.placement ?? '·'}</td>
            </tr>
        `).join('');
        for (const header of el('standingsHead').querySelectorAll('th')) {
            header.addEventListener('click', () => {
                const key = header.dataset.sort;
                standingsSort = standingsSort.key === key
                    ? { key, descending: !standingsSort.descending }
                    : { key, descending: true };
                renderStandings();
            });
        }
    }

    function renderBootOrder(game) {
        const boots = game.bootOrder || [];
        el('bootCount').textContent = boots.length ? `${boots.length} out` : '';
        if (!boots.length) {
            el('bootOrder').innerHTML = '<div class="empty">Nobody has been voted out yet.</div>';
            return;
        }
        el('bootOrder').innerHTML = [...boots].reverse().map(id => {
            const player = game.players?.[id] || {};
            const role = player.jury ? 'jury' : 'pre-merge boot';
            return `<div class="rel-row">
                <div>
                    <div class="rel-pair"><strong>${esc(id)}</strong></div>
                    <div class="rel-signals">Round ${esc(player.eliminatedRound ?? '?')} · ${esc(role)}</div>
                </div>
                <div class="rel-score">#${esc(player.placement ?? '?')}</div>
            </div>`;
        }).join('');
    }

    function tallyRows(counts) {
        const entries = Object.entries(counts || {}).sort((left, right) => right[1] - left[1]);
        const high = Math.max(1, ...entries.map(entry => entry[1]));
        return entries.map(([id, count]) => `
            <div class="tally-row">
                <div>
                    <div>${esc(id)}</div>
                    <div class="tally-bar" style="width:${Math.round((count / high) * 100)}%"></div>
                </div>
                <div class="tally-count">${count}</div>
            </div>
        `).join('');
    }

    function ballotText(ballots) {
        return Object.entries(ballots || {})
            .map(([voter, target]) => `${voter} → ${target}`)
            .join(' · ');
    }

    const VOTING_PHASES = ['voting', 'revote', 'jury_voting', 'finalist_tiebreak'];

    function renderVoteBoard(game) {
        const received = Number(game.ballotCount || 0);
        const expected = game.eligibleVoterIds?.length || 0;
        const live = el('voteLive');
        el('voteCount').textContent = phaseLabel(game.phase);

        if (VOTING_PHASES.includes(game.phase) && expected) {
            const percent = Math.round((received / expected) * 100);
            live.innerHTML = `
                <div><strong>${received}/${expected}</strong> secret ballots received</div>
                <div class="vote-progress"><span style="width:${percent}%"></span></div>
                <div class="chips">
                    ${(game.eligibleTargetIds || []).map(id =>
                        `<span class="chip danger">${esc(id)}</span>`).join('')}
                </div>
                <div class="rel-signals" style="margin-top:6px">Voting: ${esc(names(game.eligibleVoterIds))}</div>
            `;
        } else if (game.phase === 'tribal_council') {
            const answered = (state.council?.questions || [])
                .reduce((total, question) => total + question.answers.length, 0);
            live.innerHTML = `
                <div><strong>Tribal Council in session.</strong> No ballots until you close it.</div>
                <div class="rel-signals">${state.council?.questions?.length || 0} questions asked
                    · ${answered} answers on the record</div>
                <div class="chips" style="margin-top:6px">
                    ${(game.eligibleTargetIds || []).map(id =>
                        `<span class="chip danger">${esc(id)}</span>`).join('')}
                </div>
            `;
        } else if (game.phase === 'deadlock') {
            live.innerHTML = `
                <div><strong>Deadlock</strong> between ${esc(names(game.tiedIds))}</div>
                <div class="rel-signals">${game.deadlockDecisionCount || 0} of ${game.eligibleVoterIds?.length || 0}
                    decisions in. A split sends the tribe to rocks.</div>
            `;
        } else if (game.phase === 'fire_making') {
            live.innerHTML = `<div><strong>Fire-making tiebreak</strong>: ${esc(names(game.tiedIds))}</div>`;
        } else if (game.phase === 'jury_questioning') {
            live.innerHTML = `
                <div><strong>Final ${esc(game.finalistCount)}</strong>: ${esc(names(game.finalistIds))}</div>
                <div class="rel-signals">Jury of ${game.juryIds?.length || 0}: ${esc(names(game.juryIds))}</div>
            `;
        } else if (game.status === 'completed') {
            live.innerHTML = `<div><strong>Sole Survivor:</strong> ${esc(names(game.winnerIds))}</div>`;
        } else {
            live.innerHTML = '<div class="empty">No vote in progress.</div>';
        }

        const reveals = (game.events || []).filter(event =>
            event.type === 'vote.revealed'
            || event.type === 'jury.vote.revealed'
            || event.type === 'jury.tiebreak.revealed'
            || event.type === 'rocks.drawn'
        );
        if (!reveals.length) {
            el('voteHistory').innerHTML = '<div class="empty">No votes revealed yet.</div>';
            return;
        }
        el('voteHistory').innerHTML = [...reveals].reverse().map(event => {
            if (event.type === 'rocks.drawn') {
                return `<div class="vote-block">
                    <h3>Round ${esc(event.round)} · rocks</h3>
                    <div>${esc(event.eliminatedId)} drew the purple rock.</div>
                    <div class="ballot-list">Drawers: ${esc(names(event.drawerIds))}</div>
                </div>`;
            }
            if (event.type === 'jury.tiebreak.revealed') {
                return `<div class="vote-block">
                    <h3>Round ${esc(event.round)} · finalist tiebreak</h3>
                    <div>${esc(event.voterId)} crowned ${esc(event.winnerId)}.</div>
                </div>`;
            }
            const label = event.type === 'jury.vote.revealed'
                ? 'jury vote'
                : `${phaseLabel(event.phase || 'vote')}`;
            return `<div class="vote-block">
                <h3>Round ${esc(event.round)} · ${esc(label)}</h3>
                ${tallyRows(event.counts)}
                <div class="ballot-list">${esc(ballotText(event.ballots))}</div>
            </div>`;
        }).join('');
    }

    // —— Challenge deck ——————————————————————————————————————————

    function serverDeck() {
        return (state?.upcomingChallenges || []).map(item => item.gameId);
    }

    function workingDeck() {
        return deckDraft || serverDeck();
    }

    function deckDirty() {
        if (!deckDraft) return false;
        const server = serverDeck();
        return deckDraft.length !== server.length
            || deckDraft.some((gameId, index) => gameId !== server[index]);
    }

    function editDeck(mutate) {
        const next = [...workingDeck()];
        mutate(next);
        deckDraft = next;
        renderDeck();
    }

    function renderDeckAddOptions() {
        el('deckAddSelect').innerHTML = games
            .map(game => `<option value="${esc(game.id)}">${esc(game.title)}</option>`)
            .join('');
    }

    function renderDeck() {
        const deck = workingDeck();
        const startRound = state?.upcomingChallenges?.[0]?.round ?? currentGame()?.round ?? 1;
        const box = el('deckRows');
        const over = currentGame()?.status !== 'running';
        el('deckAddBtn').disabled = over;
        el('deckAddSelect').disabled = over;
        if (over) {
            box.innerHTML = '<div class="empty">The season is over — no more challenges to queue.</div>';
            el('deckDirty').hidden = true;
            el('deckSaveBtn').disabled = true;
            el('deckRevertBtn').disabled = true;
            return;
        }
        if (!deck.length) {
            box.innerHTML = '<div class="empty">No challenges queued.</div>';
        } else {
            box.innerHTML = deck.map((gameId, index) => `
                <div class="deck-row ${index === 0 ? 'next' : ''}" draggable="true" data-index="${index}">
                    <span class="deck-round">R${startRound + index}</span>
                    <select data-action="swap" aria-label="Challenge for round ${startRound + index}">
                        ${games.map(game =>
                            `<option value="${esc(game.id)}"${game.id === gameId ? ' selected' : ''}>${esc(game.title)}</option>`
                        ).join('')}
                    </select>
                    <span class="deck-actions">
                        <button type="button" class="btn btn-ghost btn-icon" data-action="up" ${index === 0 ? 'disabled' : ''} title="Move earlier">↑</button>
                        <button type="button" class="btn btn-ghost btn-icon" data-action="down" ${index === deck.length - 1 ? 'disabled' : ''} title="Move later">↓</button>
                        <button type="button" class="btn btn-ghost btn-icon" data-action="remove" ${deck.length <= 1 ? 'disabled' : ''} title="Remove">✕</button>
                    </span>
                </div>
            `).join('');
            wireDeckRows();
        }

        const dirty = deckDirty();
        el('deckDirty').hidden = !dirty;
        el('deckSaveBtn').disabled = !dirty;
        el('deckRevertBtn').disabled = !deckDraft;
    }

    function wireDeckRows() {
        const box = el('deckRows');
        for (const row of box.querySelectorAll('.deck-row')) {
            const index = Number(row.dataset.index);
            row.querySelector('[data-action="up"]').addEventListener('click', () => {
                editDeck(deck => deck.splice(index - 1, 0, deck.splice(index, 1)[0]));
            });
            row.querySelector('[data-action="down"]').addEventListener('click', () => {
                editDeck(deck => deck.splice(index + 1, 0, deck.splice(index, 1)[0]));
            });
            row.querySelector('[data-action="remove"]').addEventListener('click', () => {
                editDeck(deck => deck.splice(index, 1));
            });
            row.querySelector('[data-action="swap"]').addEventListener('change', event => {
                const gameId = event.target.value;
                editDeck(deck => { deck[index] = gameId; });
            });
            row.addEventListener('dragstart', event => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', String(index));
                row.classList.add('dragging');
            });
            row.addEventListener('dragend', () => row.classList.remove('dragging'));
            row.addEventListener('dragover', event => {
                event.preventDefault();
                row.classList.add('drop-target');
            });
            row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
            row.addEventListener('drop', event => {
                event.preventDefault();
                row.classList.remove('drop-target');
                const from = Number(event.dataTransfer.getData('text/plain'));
                if (Number.isNaN(from) || from === index) return;
                editDeck(deck => deck.splice(index, 0, deck.splice(from, 1)[0]));
            });
        }
    }

    function renderChallengeHistory(game) {
        const completed = (game.events || []).filter(event => event.type === 'challenge.completed');
        el('challengeCount').textContent = completed.length ? `${completed.length} played` : '';
        if (!completed.length) {
            el('challengeHistory').innerHTML = '<div class="empty">No challenges finished yet.</div>';
            return;
        }
        const started = (game.events || []).filter(event => event.type === 'challenge.started');
        el('challengeHistory').innerHTML = [...completed].reverse().map(event => {
            const opener = started.find(item => item.round === event.round);
            const winner = event.winnerId
                ? `${event.winnerId} took individual immunity`
                : `${event.winningTribe} won immunity · ${event.councilTribe} to council`;
            return `<div class="rel-row">
                <div>
                    <div class="rel-pair"><strong>${esc(gameTitle(opener?.id))}</strong></div>
                    <div class="rel-signals">${esc(winner)}</div>
                </div>
                <div class="rel-score">R${esc(event.round)}</div>
            </div>`;
        }).join('');
    }

    // —— Timeline ————————————————————————————————————————————————

    function describeEvent(event) {
        switch (event.type) {
            case 'season.started':
                return { text: `Season started with ${event.participantIds?.length || 0} castaways`, tone: 'big' };
            case 'challenge.started':
                return { text: `${gameTitle(event.id)} begins (${event.mode})`, tone: '' };
            case 'challenge.completed':
                return event.winnerId
                    ? { text: `${event.winnerId} wins individual immunity`, tone: 'good' }
                    : { text: `${event.winningTribe} wins immunity — ${event.councilTribe} goes to council`, tone: 'good' };
            case 'council.opened':
                return {
                    text: event.kind === 'final'
                        ? `Final Tribal Council opens with ${event.attendeeIds?.length || 0} present`
                        : `Tribal Council opens: ${event.attendeeIds?.length || 0} present, ${event.targetIds?.length || 0} vulnerable`,
                    tone: 'big',
                };
            case 'council.question':
                return { text: `Jeff asks ${names(event.targetIds)}: "${event.prompt}"`, tone: 'big' };
            case 'council.answer':
                return { text: `${event.playerId}: "${event.answer}"`, tone: '' };
            case 'vote.started':
                return { text: `Council closed — ${event.voters?.length || 0} voting, ${event.targets?.length || 0} vulnerable`, tone: '' };
            case 'ballot.cast':
                return { text: `${event.voterId} cast a ballot`, tone: '' };
            case 'ballots.autofilled':
                return { text: `${event.ballots?.length || 0} ballots auto-filled at the buzzer`, tone: '' };
            case 'vote.revealed':
                return { text: `Votes revealed: ${ballotText(event.ballots)}`, tone: '' };
            case 'revote.started':
                return { text: `Tie between ${names(event.tiedIds)} — revote`, tone: 'bad' };
            case 'deadlock.started':
                return { text: `Deadlock between ${names(event.tiedIds)}`, tone: 'bad' };
            case 'deadlock.decision':
                return { text: `${event.voterId} submitted a deadlock decision`, tone: '' };
            case 'deadlock.decisions-autofilled':
                return { text: 'Deadlock decisions auto-filled', tone: '' };
            case 'rocks.drawn':
                return { text: `Rocks drawn — ${event.eliminatedId} goes home`, tone: 'bad' };
            case 'fire_making.started':
                return { text: `Fire-making: ${names(event.contestantIds)}`, tone: 'big' };
            case 'fire_making.completed':
                return { text: `${event.winnerId} made fire; ${event.eliminatedId} is out`, tone: 'bad' };
            case 'vote.no_voter_tiebreak':
                return { text: `No voters left — ${event.eliminatedId} eliminated by tiebreak`, tone: 'bad' };
            case 'player.eliminated':
                return {
                    text: `${event.playerId} voted out (#${event.placement}${event.joinsJury ? ', joins jury' : ''})`,
                    tone: 'bad',
                };
            case 'finalists.reached':
                return { text: `Finalists: ${names(event.finalistIds)}`, tone: 'big' };
            case 'tribes.merged':
                return { text: 'The tribes have merged', tone: 'big' };
            case 'jury.vote.started':
                return { text: `Jury of ${event.jurorIds?.length || 0} votes for a winner`, tone: 'big' };
            case 'jury.vote.revealed':
                return { text: `Jury votes: ${ballotText(event.ballots)}`, tone: '' };
            case 'jury.tiebreak.started':
                return { text: `${event.voterId} breaks the jury tie`, tone: 'big' };
            case 'jury.three_way_tie':
                return { text: `Three-way jury tie — ${event.winnerId} wins the draw`, tone: 'big' };
            case 'jury.tiebreak.revealed':
                return { text: `${event.voterId} crowned ${event.winnerId}`, tone: 'big' };
            case 'season.completed':
                return { text: `${event.winnerId} is the Sole Survivor`, tone: 'big' };
            case 'season.cancelled':
                return { text: `Season cancelled: ${event.reason || 'no reason given'}`, tone: 'bad' };
            default:
                return { text: phaseLabel(event.type), tone: '' };
        }
    }

    function renderTimeline(game) {
        const events = game.events || [];
        el('timelineCount').textContent = `${events.length} events`;
        el('timeline').innerHTML = [...events].reverse().map(event => {
            const described = describeEvent(event);
            return `<div class="timeline-entry ${described.tone}">
                <span class="timeline-round">R${esc(event.round ?? '·')}</span>
                <span class="timeline-text">${esc(described.text)}</span>
            </div>`;
        }).join('');
    }

    function renderActiveChallenge() {
        const box = el('activeChallenge');
        const game = currentGame();
        if (!state?.challengeContestId || !game) {
            box.innerHTML = '';
            return;
        }
        const contest = activeContest;
        const title = contest?.title || gameTitle(game.challenge?.id);
        const deadline = contest?.deadlineAt ? formatCountdown(contest.deadlineAt) : '—';
        box.innerHTML = `
            <div class="challenge-live">
                <div class="title">${esc(title)}</div>
                <div class="meta">${esc(contest?.status || 'running')} · ends in ${esc(deadline)}
                    · ${esc(contest?.participantIds?.length || activeIds(game).length)} competing</div>
            </div>
        `;
    }

    function renderRelationships() {
        const edges = state?.relationships?.edges || [];
        el('relCount').textContent = edges.length ? `${edges.length} pairs` : '';
        if (!edges.length) {
            el('relationships').innerHTML = '<div class="empty">No alliances or grudges on record yet.</div>';
            return;
        }
        el('relationships').innerHTML = edges.map(edge => {
            const signals = [];
            if (edge.roomsShared) signals.push(`${edge.roomsShared} private room${edge.roomsShared > 1 ? 's' : ''}`);
            if (edge.messagesExchanged) signals.push(`${edge.messagesExchanged} messages`);
            if (edge.sharedVoteTargets) signals.push(`voted together ${edge.sharedVoteTargets}x`);
            const against = edge.votesFromAToB + edge.votesFromBToA;
            if (against) signals.push(`${against} vote${against > 1 ? 's' : ''} against`);
            if (edge.juryVotesFor) signals.push('jury vote');
            return `<div class="rel-row">
                <div>
                    <div class="rel-pair"><strong>${esc(edge.a)}</strong> &amp; <strong>${esc(edge.b)}</strong></div>
                    <div class="rel-signals">${esc(signals.join(' · ') || 'no signal')}</div>
                </div>
                <div class="rel-score ${edge.score >= 0 ? 'bond' : 'friction'}">
                    ${edge.score >= 0 ? '+' : ''}${esc(edge.score)}
                </div>
            </div>`;
        }).join('');
    }

    function renderRooms() {
        const rooms = state?.rooms || [];
        el('roomCount').textContent = rooms.length ? `${rooms.length} open` : 'none open';
        el('rooms').innerHTML = rooms.length
            ? rooms.map(room => `
                <div class="room-card">
                    <div class="members">${esc(names(room.memberIds))}</div>
                    <div class="meta">owner ${esc(room.ownerId)} · ${room.messageCount} messages
                        ${room.invitedIds?.length ? ` · invited ${esc(names(room.invitedIds))}` : ''}</div>
                </div>`).join('')
            : '<div class="empty">No private rooms open right now.</div>';
    }

    function renderSecretFeed() {
        const feed = el('secretFeed');
        if (!secretEvents.length) {
            feed.innerHTML = '<div class="secret-entry system">Private talk shows up here in every phase, operators only.</div>';
            return;
        }
        feed.innerHTML = secretEvents.map(event => {
            if (event.type === 'room.message') {
                return `<div class="secret-entry">
                    <span class="who">${esc(event.senderId)}</span>
                    → [${esc(names(event.memberIds))}]: ${esc(event.message)}
                </div>`;
            }
            if (event.type === 'room.created') {
                return `<div class="secret-entry system">Room opens: ${esc(event.ownerId)} with ${esc(names(event.invitedIds))}${event.pitch ? ` — "${esc(event.pitch)}"` : ''}</div>`;
            }
            if (event.type === 'talk.requested') {
                return `<div class="secret-entry system">${esc(event.requesterId)} asks to talk with ${esc(names(event.inviteeIds))}${event.pitch ? ` — "${esc(event.pitch)}"` : ''}</div>`;
            }
            if (event.type === 'talk.accepted') {
                return `<div class="secret-entry system">${esc(event.inviteeId)} agrees to talk with ${esc(event.requesterId)}</div>`;
            }
            if (event.type === 'talk.declined') {
                return `<div class="secret-entry system">${esc(event.inviteeId)} refuses ${esc(event.requesterId)}${event.reason ? ` — "${esc(event.reason)}"` : ''}</div>`;
            }
            if (event.type === 'talk.resolved') {
                return `<div class="secret-entry system">Request ${esc(event.status)}${event.accepterIds?.length ? `: ${esc(names(event.accepterIds))} in` : ': nobody joined'}</div>`;
            }
            if (event.type === 'talk.cancelled') {
                return `<div class="secret-entry system">${esc(event.requesterId)}'s request cancelled (${esc(event.reason)})</div>`;
            }
            if (event.type === 'room.joined') {
                return `<div class="secret-entry system">${esc(event.memberId)} joined a private room</div>`;
            }
            if (event.type === 'room.left') {
                return `<div class="secret-entry system">${esc(event.memberId)} left a private room</div>`;
            }
            if (event.type === 'room.closed') {
                return `<div class="secret-entry system">Room closed (${esc(event.reason)})</div>`;
            }
            return `<div class="secret-entry system">${esc(String(event.type).replaceAll(/[._]/g, ' '))}</div>`;
        }).join('');
        feed.scrollTop = feed.scrollHeight;
    }

    function renderJoin() {
        const card = el('joinCard');
        const address = join?.address || (join?.host ? `${join.host}:${join.port}` : '');
        card.hidden = !address;
        card.textContent = address ? `Watch in Minecraft at ${address}` : '';
    }

    // —— Season setup ——————————————————————————————————————————————

    function renderScenarios() {
        const select = el('scenarioSelect');
        const previous = select.value;
        select.innerHTML = scenarios.map(scenario =>
            `<option value="${esc(scenario.scenarioId)}">${esc(scenario.title)} · ${esc(scenario.castSize)} bots</option>`
        ).join('');
        if (previous && scenarios.some(item => item.scenarioId === previous)) select.value = previous;
        renderScenarioBlurb();
    }

    function selectedScenario() {
        return scenarios.find(item => item.scenarioId === el('scenarioSelect').value)
            || scenarios[0]
            || preset;
    }

    function renderScenarioBlurb() {
        const scenario = selectedScenario();
        if (scenario?.blurb) el('startBlurb').textContent = scenario.blurb;
    }

    function updateStartButton() {
        const button = el('startSeasonBtn');
        const cheapButton = el('startCheapTestBtn');
        const game = currentGame();
        const ready = profiles.length > 0 && scenarios.length > 0;
        const cheapProfile = profiles.find(profile => profile.id === CHEAP_TEST_PROFILE_ID);
        const cheapScenario = scenarios.find(scenario => scenario.scenarioId === CHEAP_TEST_SCENARIO_ID);
        button.disabled = !ready || gameSetup?.isBusy();
        cheapButton.disabled = !cheapProfile || !cheapScenario || gameSetup?.isBusy();
        cheapButton.title = cheapProfile
            ? `Four bots using ${cheapProfile.name} (${cheapProfile.model})`
            : 'GPT-5.6 Luna Instant is not configured';
        button.textContent = !ready
            ? 'Loading cast…'
            : game?.status === 'completed' ? 'Start new season' : 'Start season';
        el('startPanel').querySelector('h2').textContent = game?.status === 'completed'
            ? 'Season complete'
            : 'No season running';
    }

    // Bot names are only reserved while their bot is online and not already
    // playing a game, matching how the games dashboard picks names.
    function reservedNames() {
        return agents
            .filter(agent => (agent.in_game || agent.socket_connected) && !agent.gameSession)
            .map(agent => agent.name);
    }

    function openSeasonSetup(options = {}) {
        const scenario = options.scenario || selectedScenario();
        if (!Array.isArray(preset?.defaultCharacters)) {
            setStatus('Loading the canonical Survivor cast. Try again in a moment.');
            loadStatus();
            return;
        }
        const characters = scenario?.defaultCharacters || [];
        const participants = gameSetup.defaultParticipantsFor(
            characters,
            Number(scenario?.castSize) || characters.length || 4
        );
        if (options.profileId) {
            for (const participant of participants) participant.profileId = options.profileId;
        }
        gameSetup.open({
            gameId: 'survivor',
            title: options.title || `Set up ${scenario?.title || 'Survivor Bot Season'}`,
            submitLabel: 'Start season',
            footer: options.footer
                || `The roster persists through immunity challenges, Tribal Councils, and a final ${scenario?.finalistCount || 3} judged by the jury.`,
            participants,
            duration: null,
            minParticipants: Number(scenario?.minimumPlayers) || 4,
            minParticipantsError: `Survivor needs at least ${Number(scenario?.minimumPlayers) || 4} starting bots`,
            fields: [
                { id: 'mergeAt', label: 'Merge remaining', min: 4, max: 10, step: 1, value: scenario?.mergeAt || 10 },
                {
                    id: 'strategyMinutes',
                    label: 'Strategy min',
                    min: 0.5,
                    max: 10,
                    step: 0.5,
                    value: (scenario?.phaseDurationsMs?.strategy || 120_000) / 60_000,
                },
                {
                    id: 'councilMinutes',
                    label: 'Council min',
                    min: 0.5,
                    max: 10,
                    step: 0.5,
                    value: (scenario?.phaseDurationsMs?.tribalCouncil || 300_000) / 60_000,
                },
                {
                    id: 'voteMinutes',
                    label: 'Vote min',
                    min: 0.5,
                    max: 5,
                    step: 0.5,
                    value: (scenario?.phaseDurationsMs?.voting || 60_000) / 60_000,
                },
            ],
            validate: ({ fields }) => {
                if (!Number.isInteger(fields.mergeAt) || fields.mergeAt < 4 || fields.mergeAt > 10) {
                    return 'Survivor merge count must be from 4 to 10';
                }
                return null;
            },
            buildRequest: ({ participants, systemPrompt, fields }) => ({
                event: 'survivor-start',
                payload: {
                    participants,
                    systemPrompt,
                    scenarioId: scenario?.scenarioId,
                    mergeAt: fields.mergeAt,
                    councilAutoAdvance: el('councilAutoAdvance').checked,
                    phaseDurationsMs: {
                        strategy: fields.strategyMinutes * 60_000,
                        tribal_council: fields.councilMinutes * 60_000,
                        voting: fields.voteMinutes * 60_000,
                    },
                },
            }),
            onStarted: result => {
                setStatus('Season started.');
                if (result.data?.join) {
                    join = result.data.join;
                    renderJoin();
                }
                loadStatus();
            },
        });
    }

    function openCheapTest() {
        const scenario = scenarios.find(item => item.scenarioId === CHEAP_TEST_SCENARIO_ID);
        const profile = profiles.find(item => item.id === CHEAP_TEST_PROFILE_ID);
        if (!scenario || !profile) {
            setStatus('Cheap test requires the configured GPT-5.6 Luna Instant profile.', true);
            return;
        }
        el('scenarioSelect').value = scenario.scenarioId;
        renderScenarioBlurb();
        openSeasonSetup({
            scenario,
            profileId: profile.id,
            title: 'Set up cheap Survivor test',
            footer: `All four bots use ${profile.name} with instant/no reasoning—the lowest-cost model profile available here. Review the cast, then start.`,
        });
    }

    // —— Wiring ——————————————————————————————————————————————————

    gameSetup = window.createGameSetup({
        socket,
        getProfiles: () => profiles,
        getReservedNames: reservedNames,
        onStatus: setStatus,
        onBusyChange: () => updateStartButton(),
    });

    el('startSeasonBtn').addEventListener('click', openSeasonSetup);
    el('startCheapTestBtn').addEventListener('click', openCheapTest);
    el('scenarioSelect').addEventListener('change', renderScenarioBlurb);
    el('pauseBtn').addEventListener('click', () => control(state?.paused ? 'resume' : 'pause'));
    el('advanceBtn').addEventListener('click', () => control('advance'));
    el('cancelSeasonBtn').addEventListener('click', () => {
        if (window.confirm('Cancel the active Survivor season and disconnect its bots?')) {
            control('cancel', { reason: 'Cancelled from the Survivor control room' });
        }
    });
    el('deckSaveBtn').addEventListener('click', () => {
        const gameIds = workingDeck();
        if (!gameIds.length) {
            setStatus('Add at least one challenge before saving', true);
            return;
        }
        control('set-challenge-deck', { gameIds });
    });
    el('deckRevertBtn').addEventListener('click', () => {
        deckDraft = null;
        renderDeck();
    });
    el('deckAddBtn').addEventListener('click', () => {
        const gameId = el('deckAddSelect').value;
        if (gameId) editDeck(deck => deck.push(gameId));
    });
    el('askBtn').addEventListener('click', askQuestion);
    // Ctrl/Cmd+Enter asks without reaching for the mouse, since hosting is typing.
    el('questionText').addEventListener('keydown', event => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) askQuestion();
    });
    el('councilCloseBtn').addEventListener('click', () => control('end-council'));
    for (const button of document.querySelectorAll('[data-pick]')) {
        button.addEventListener('click', () => {
            const live = council();
            if (!live) return;
            const game = currentGame();
            if (button.dataset.pick === 'all') askTargets = new Set(live.askableIds);
            else if (button.dataset.pick === 'none') askTargets = new Set();
            else {
                askTargets = new Set((game.eligibleTargetIds || [])
                    .filter(id => live.askableIds.includes(id)));
            }
            renderTargetPicker(live, game);
        });
    }
    el('holdPhaseBtn').addEventListener('click', () => control('set-phase-deadline', { seconds: null }));
    el('rushPhaseBtn').addEventListener('click', () => control('set-phase-deadline', { seconds: 5 }));
    el('copyDiagBtn').addEventListener('click', copyDiagnostics);

    socket.on('connect', () => {
        el('msStatus').textContent = 'mindserver online';
        el('msStatus').className = 'status-pill online';
        loadStatus();
        loadProfiles();
    });

    socket.on('disconnect', () => {
        el('msStatus').textContent = 'mindserver offline';
        el('msStatus').className = 'status-pill offline';
    });

    socket.on('survivor-update', applyState);

    socket.on('survivor-secret-event', event => {
        secretEvents.push(event);
        if (secretEvents.length > 300) secretEvents.shift();
        renderSecretFeed();
    });

    socket.on('contest-update', view => {
        const contests = view?.contests || [];
        activeContest = contests.find(contest => contest.id === view?.activeContestId) || null;
        if (currentGame()) renderActiveChallenge();
    });

    socket.on('agents-status', list => {
        agents = list || [];
    });

    // Only the countdown changes between server updates, so tick just that.
    setInterval(() => {
        if (!state?.game) return;
        el('hudCountdown').textContent = phaseClockLabel();
    }, 1000);

    if (typeof window.initBotVoice === 'function') window.initBotVoice(socket);
})();
