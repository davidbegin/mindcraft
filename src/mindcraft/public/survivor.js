// Survivor control room. Everything here is driven by three server messages:
// the survivor-status ack on load, survivor-update on every state change, and
// survivor-secret-event for private alliance chatter.
(function () {
    const socket = window.io();
    const CHEAP_TEST_PROFILE_ID = 'gpt-5-6-luna-instant';
    const CHEAP_TEST_SCENARIO_ID = 'four_player';
    const CHEAP_SIX_TEST_SCENARIO_ID = 'six_player';

    let state = null;          // SurvivorSessionManager.view()
    let games = [];            // contest game presets, for challenge names
    let scenarios = [];
    let preset = null;
    let join = null;
    let profiles = [];
    let agents = [];
    let botModelLineups = [];
    let botPersonas = [];
    let defaultBotModelLineupId = 'variety';
    let secretEvents = [];
    let activeContest = null;
    let deckDraft = null;      // staged reorder, null while in sync with server
    let standingsSort = { key: 'default', descending: true };
    let gameSetup = null;
    let askTargets = new Set();   // who the next question goes to
    let pickerRoster = '';        // rebuild the picker only when the cast changes
    let resultsPick = null;       // which revealed vote the results panel is showing
    let resultsFollow = true;     // jump to each new reveal until the host looks back

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
        // Blindside pack
        'Did anyone here get blindsided last vote — and who set it up?',
        'If the person next to you is going home, will you own that vote to their face?',
        'Name the blindside you are cooking right now, or admit you do not have one.',
        // Idol pack
        'Is there a Hidden Immunity Idol in play? Who has it?',
        'If you had the idol tonight, who would you flush it on?',
        'Why should anyone believe you when you say you do not have an idol?',
        // Jury pack
        'Look at the jury seats. Which of them still respects your game?',
        'Who on the jury will never vote for you, and what will you do about it?',
        'Are you playing for the jury already, or only for tonight?',
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
        if (suspended()) return 'parked';
        if (state?.paused) {
            if (state.pausedDeadlineRemainingMs != null) {
                return `paused (${formatRemainingMs(state.pausedDeadlineRemainingMs)})`;
            }
            return 'paused';
        }
        if (!state?.phaseDeadlineAt) return 'you decide';
        return formatCountdown(state.phaseDeadlineAt);
    }

    function formatRemainingMs(ms) {
        const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        return `${minutes}:${String(totalSeconds % 60).padStart(2, '0')}`;
    }

    function runStateLabel(run) {
        if (!run) return '';
        const clock = {
            frozen: 'clocks frozen',
            'host-held': 'clocks host-held',
            ticking: 'clocks ticking',
        }[run.clocks] || `clocks ${run.clocks}`;
        const bots = {
            active: 'bots active',
            paused: 'bots paused',
            evicted: 'bots evicted',
        }[run.bots] || `bots ${run.bots}`;
        const voices = run.voices === 'live'
            ? 'voices live'
            : `voices ${run.voices}-muted`;
        const cast = run.castPreserved ? 'cast preserved' : 'cast must respawn';
        return `${clock} · ${bots} · ${voices} · ${cast}`;
    }

    function suspended() {
        return state?.status === 'suspended';
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
            if (Array.isArray(result.botModelLineups)) botModelLineups = result.botModelLineups;
            if (Array.isArray(result.botPersonas)) botPersonas = result.botPersonas;
            if (result.defaultBotModelLineupId) {
                defaultBotModelLineupId = result.defaultBotModelLineupId;
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
        renderSuspendedBanner(game);
        renderReadiness();
        updateStartButton();
        if (!game) {
            el('voteResults').hidden = true;
            el('harnessPanel').hidden = true;
            renderSecretFeed();
            return;
        }
        renderHud(game);
        renderHarness(game);
        renderCouncil(game);
        renderTribes(game);
        renderStandings();
        renderBootOrder(game);
        renderVoteBoard(game);
        renderVoteResults(game);
        renderDeck();
        renderChallengeHistory(game);
        renderTimeline(game);
        renderActiveChallenge();
        renderRelationships();
        renderTalkRequests();
        renderRooms();
        renderSecretFeed();
        renderDiagnostics();
        // Portraits are canvases inside markup that was just replaced, so they
        // are repainted after every render. Decoded skins are cached.
        window.mcAvatar?.paint();
    }

    // —— Scenario harness ————————————————————————————————————————

    function harnessPayload() {
        const game = currentGame();
        const immuneId = el('harnessImmuneSelect').value;
        if (!game || !immuneId) return {};
        if (game.merged) {
            return { winnerId: immuneId, immunityIds: [immuneId] };
        }
        const tribe = game.players?.[immuneId]?.tribe;
        return {
            winnerId: immuneId,
            winningTribe: tribe,
            immunityIds: [immuneId],
        };
    }

    function renderHarness(game) {
        const panel = el('harnessPanel');
        const running = game.status === 'running' && !suspended();
        const usable = running && ['challenge', 'strategy'].includes(game.phase);
        panel.hidden = !running;
        const select = el('harnessImmuneSelect');
        const remaining = activeIds(game);
        const previous = select.value;
        select.innerHTML = remaining.map(id =>
            `<option value="${esc(id)}">${esc(id)}${
                (game.immunityIds || []).includes(id) ? ' (immune)' : ''
            }</option>`
        ).join('');
        if (previous && remaining.includes(previous)) select.value = previous;
        else if ((game.immunityIds || [])[0]) select.value = game.immunityIds[0];
        const meetSelect = el('harnessMeetSelect');
        if (meetSelect) {
            const meetPrevious = meetSelect.value;
            const partner = remaining.filter(id => id !== select.value);
            meetSelect.innerHTML = partner.map(id =>
                `<option value="${esc(id)}">${esc(id)}</option>`
            ).join('');
            if (meetPrevious && partner.includes(meetPrevious)) meetSelect.value = meetPrevious;
        }
        el('harnessSetImmunityBtn').disabled = !usable || game.phase !== 'strategy';
        el('harnessDeclareWinnerBtn').disabled = !usable || game.phase !== 'challenge';
        el('harnessSkipChallengeBtn').disabled = !usable || game.phase !== 'challenge';
        el('harnessJumpCouncilBtn').disabled = !usable;
        const forceMeetBtn = el('harnessForceMeetBtn');
        if (forceMeetBtn) {
            forceMeetBtn.disabled = !running
                || !['strategy', 'tribal_council', 'reevaluation', 'voting', 'revote', 'jury_questioning', 'jury_voting'].includes(game.phase)
                || remaining.length < 2;
        }
        el('harnessHint').textContent = game.phase === 'challenge'
            ? (game.merged
                ? 'Declare a winner, skip (assigns immunity), or jump straight to Tribal.'
                : 'Declare a winning tribe via any member, skip, or jump to Tribal.')
            : game.phase === 'strategy'
                ? `Strategy open. Vulnerable: ${names(game.eligibleTargetIds) || '—'}. Jump opens council.`
                : `Harness idle during ${phaseLabel(game.phase)}.`;
        const recording = el('recordingHint');
        if (recording) {
            const pov = state?.recordingEnabled ? 'POV on' : 'POV off';
            const cams = state?.autoRecordingEnabled ? 'contest cams on' : 'contest cams off';
            recording.textContent = `Recording: ${pov} · ${cams}. Full-season A/V+journal packaging is still follow-on work.`;
        }
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
            : 'Close council and start re-evaluation';
        renderTargetPicker(live, game);
        renderPresetQuestions(isFinal);
        renderTranscript(live);
        // The record stays readable while the season is parked, but nothing can
        // be put on it until the cast is back in the world.
        el('councilCloseBtn').disabled = suspended();
        el('questionText').disabled = suspended();
        if (suspended()) el('askBtn').disabled = true;
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
        const stats = state?.conversationStats;
        const statsBox = el('talkStats');
        if (statsBox) {
            statsBox.textContent = stats
                ? `Talk drill: ${stats.asked} asked · ${stats.accepted} accepted · ${stats.declined} refused · ${stats.roomsOpened} rooms opened · ${stats.pending} pending · ${stats.openRooms} open now`
                : '';
        }
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
            const ttl = request.expiresAt == null
                ? 'open until strategy ends'
                : `expires ${new Date(request.expiresAt).toLocaleTimeString()}`;
            return `<div class="talk-card ${esc(request.status)}">
                <div class="ask"><strong>${esc(request.requesterId)}</strong>
                    asked ${esc(names(request.inviteeIds))} to talk
                    <span class="rel-signals"> · ${esc(ttl)}</span></div>
                ${request.pitch ? `<div class="pitch">“${esc(request.pitch)}”</div>` : ''}
                <div class="answers">${answers}</div>
            </div>`;
        }).join('');
    }

    // —— Diagnostics ——————————————————————————————————————————————

    /**
     * Council is meant to be heard, so a dead microphone is a headline rather
     * than a diagnostics row. Failures needing a human (credits, keys) stay red;
     * transient ones (rate limits, network) are amber and clear themselves.
     */
    function renderVoiceHealth(health) {
        const box = el('voiceAlert');
        if (!box) return;
        const problem = health?.outage || (health?.ok === false ? health.lastFailure : null);
        if (!problem) {
            box.hidden = true;
            return;
        }
        box.classList.toggle('transient', !['quota', 'auth', 'config', 'voice'].includes(problem.kind));
        el('voiceAlertTitle').textContent = health.summary || 'Bot voices are failing.';
        el('voiceAlertHint').textContent = problem.hint || '';
        const bits = [problem.kind];
        if (problem.status != null) bits.push(`status ${problem.status}`);
        if (problem.code) bits.push(problem.code);
        if (problem.botName) bits.push(`first seen on ${problem.botName}`);
        if (health.failureCount > 1) bits.push(`${health.failureCount} dropped lines`);
        el('voiceAlertDetail').textContent =
            `${bits.filter(Boolean).join(' · ')}${problem.message ? ` — ${problem.message}` : ''}`;
        box.hidden = false;
    }

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
    // will actually do rather than a vague "advance". Vote phases use a separate
    // Reveal control — Advance stays off so it never autofills ballots.
    const ADVANCE_LABELS = {
        strategy: 'Open Tribal Council',
        tribal_council: 'Close council, open re-eval',
        reevaluation: 'Open voting',
        deadlock: 'Settle the deadlock',
        jury_questioning: 'Send the jury to vote',
        fire_making: 'Resolve fire-making',
    };
    const REVEAL_PHASES = ['voting', 'revote', 'jury_voting', 'finalist_tiebreak'];
    const REVEAL_LABELS = {
        voting: 'Reveal votes',
        revote: 'Reveal revote',
        jury_voting: 'Reveal jury vote',
        finalist_tiebreak: 'Reveal tiebreak',
    };

    // A parked season is easy to forget about, and forgetting is what makes it
    // reappear underneath whatever you started next. Say plainly that it is
    // waiting and make both ways out of it one click away.
    function renderSuspendedBanner(game) {
        const banner = el('suspendedBanner');
        banner.hidden = !suspended();
        if (banner.hidden) return;
        const restarted = state.suspendedReason === 'server-restart';
        el('suspendedTitle').textContent = restarted
            ? 'Season parked after restart — bots left the world'
            : 'Season parked — bots left the world';
        const where = game
            ? `Round ${game.round}, ${phaseLabel(game.phase)}, ${activeIds(game).length} still in`
            : '';
        el('suspendedDetail').textContent = restarted
            ? `${where}. Unpark to restore the cast, or cancel to free the slot.`
            : `${where}. Other games can run while it waits. Unpark restores the cast.`;
    }

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
        el('hudPaused').hidden = !state.paused || suspended();
        el('hudSuspended').hidden = !suspended();

        const run = state.operatorRunState;
        const runState = el('hudRunState');
        runState.textContent = runStateLabel(run);
        runState.dataset.mode = run?.mode || '';

        const inChallenge = game.phase === 'challenge';
        const running = game.status === 'running' && !suspended();
        const castPaused = Boolean(state.paused) && !suspended();
        el('pauseBtn').textContent = castPaused ? 'Resume' : 'Pause';
        // Pause is the primary control: available whenever the cast is in-world
        // and we are not mid-contest. Resume stays available while paused.
        el('pauseBtn').disabled = !running || (inChallenge && !castPaused);
        el('parkBtn').hidden = suspended();
        el('parkBtn').disabled = !running || Boolean(state.challengeContestId);
        const advanceLabel = ADVANCE_LABELS[game.phase];
        el('advanceBtn').textContent = advanceLabel || 'Advance phase';
        if (game.phase === 'fire_making') {
            el('advanceBtn').textContent = 'Confirm fire-making';
            el('advanceBtn').disabled = inChallenge || !running;
        } else {
            el('advanceBtn').disabled = inChallenge || !running || !advanceLabel;
        }
        const revealLabel = REVEAL_LABELS[game.phase];
        const revealBtn = el('revealVotesBtn');
        revealBtn.hidden = !revealLabel;
        revealBtn.textContent = revealLabel || 'Reveal votes';
        const missing = game.missingVoterIds || [];
        const expected = game.eligibleVoterIds?.length || 0;
        const received = Number(game.ballotCount || 0);
        revealBtn.disabled = !running
            || !revealLabel
            || expected === 0
            || received < expected
            || missing.length > 0;
        revealBtn.title = missing.length
            ? `Waiting on: ${missing.join(', ')}`
            : (received < expected ? `Waiting for ${expected - received} more ballot(s)` : '');
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

    // One-line form for the timeline. The results panel is where a vote is read
    // properly, with faces and reasons.
    function ballotText(ballots) {
        return Object.entries(ballots || {})
            .map(([voterId, targetId]) => `${voterId} → ${targetId}`)
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
            const missing = game.missingVoterIds || [];
            live.innerHTML = `
                <div><strong>${received}/${expected}</strong> secret ballots received</div>
                <div class="vote-progress"><span style="width:${percent}%"></span></div>
                <div class="chips">
                    ${(game.eligibleTargetIds || []).map(id =>
                        `<span class="chip danger">${esc(id)}</span>`).join('')}
                </div>
                <div class="rel-signals" style="margin-top:6px">Voting: ${esc(names(game.eligibleVoterIds))}</div>
                ${missing.length
                    ? `<div class="rel-signals" style="margin-top:6px;color:var(--danger, #c44)">
                        Still waiting on: <strong>${esc(names(missing))}</strong>
                       </div>`
                    : '<div class="rel-signals" style="margin-top:6px">All ballots in — ready to reveal.</div>'}
            `;
        } else if (game.phase === 'strategy') {
            const vulnerable = game.eligibleTargetIds || [];
            live.innerHTML = `
                <div><strong>Strategy window.</strong> Tribal is next.</div>
                <div class="rel-signals">Immunity: ${esc(names(game.immunityIds) || 'nobody')}</div>
                <div class="chips" style="margin-top:6px">
                    ${vulnerable.length
                        ? vulnerable.map(id => `<span class="chip danger">${esc(id)}</span>`).join('')
                        : '<span class="chip">Vulnerable list not set</span>'}
                </div>
                <div class="rel-signals" style="margin-top:6px">Vulnerable tonight: ${esc(names(vulnerable) || '—')}</div>
            `;
        } else if (game.phase === 'reevaluation') {
            live.innerHTML = `
                <div><strong>Post-council re-evaluation.</strong> Ballots are still closed.</div>
                <div class="rel-signals">Bots must reconsider the public record before you open voting.</div>
                <div class="chips" style="margin-top:6px">
                    ${(game.eligibleTargetIds || []).map(id =>
                        `<span class="chip danger">${esc(id)}</span>`).join('')}
                </div>
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
    }

    // —— Post-vote results ————————————————————————————————————————
    //
    // A revealed vote is the most consequential thing that happens in a season
    // and the hardest to read from an event log, so it gets its own panel: who
    // went home, who wrote whose name down, and the private reason each voter
    // sealed with their ballot.

    const REVEAL_TYPES = ['vote.revealed', 'jury.vote.revealed', 'jury.tiebreak.revealed'];

    function avatarHtml(name, options) {
        return window.mcAvatar?.html(name, options) ?? '';
    }

    function revealPhase(event) {
        if (event.type === 'jury.vote.revealed') return 'jury_voting';
        if (event.type === 'jury.tiebreak.revealed') return 'finalist_tiebreak';
        return event.phase || 'voting';
    }

    function chapterTab(chapter) {
        if (chapter.phase === 'jury_voting') return 'Final vote';
        if (chapter.phase === 'finalist_tiebreak') return 'Tiebreak';
        if (chapter.phase === 'revote') return `R${chapter.round} revote`;
        return `R${chapter.round}`;
    }

    function ordinal(value) {
        const number = Number(value);
        if (!Number.isFinite(number)) return '';
        const tens = number % 100;
        if (tens >= 11 && tens <= 13) return `${number}th`;
        return `${number}${['th', 'st', 'nd', 'rd'][number % 10] || 'th'}`;
    }

    function countBallots(ballots) {
        const counts = {};
        for (const targetId of Object.values(ballots || {})) {
            counts[targetId] = (counts[targetId] || 0) + 1;
        }
        return counts;
    }

    // Ballots the clock filled in for a bot that never voted, keyed by the vote
    // they belong to, so a reveal can tell a real vote from a forfeit.
    function autofilledVoters(game) {
        const byVote = new Map();
        for (const event of game.events || []) {
            if (event.type !== 'ballots.autofilled') continue;
            const key = `${event.round}:${event.phase || 'voting'}`;
            const voters = byVote.get(key) || new Set();
            for (const entry of event.ballots || []) voters.add(entry.voterId);
            byVote.set(key, voters);
        }
        return byVote;
    }

    // Who could not be voted for, by round: an immunity win is half the story of
    // why a vote landed where it did.
    function immunityByRound(game) {
        const byRound = new Map();
        for (const event of game.events || []) {
            if (event.type !== 'challenge.completed') continue;
            const immune = event.winnerId ? [event.winnerId] : (event.immunityIds || []);
            byRound.set(event.round, immune);
        }
        return byRound;
    }

    // One chapter per set of ballots read out loud, carrying whatever the game
    // then did about them: a boot, a revote, rocks, or a crowned winner.
    function voteChapters(game) {
        const autofilled = autofilledVoters(game);
        const immunity = immunityByRound(game);
        const chapters = [];
        for (const event of game.events || []) {
            if (REVEAL_TYPES.includes(event.type)) {
                const phase = revealPhase(event);
                const ballots = event.type === 'jury.tiebreak.revealed'
                    ? { [event.voterId]: event.winnerId }
                    : { ...(event.ballots || {}) };
                chapters.push({
                    round: event.round,
                    phase,
                    ballots,
                    reasons: event.reasons || {},
                    counts: event.counts || countBallots(ballots),
                    forfeitedIds: autofilled.get(`${event.round}:${phase}`) || new Set(),
                    // Immunity only shapes a council vote. It has no bearing on
                    // the jury choosing a winner, even in the same round.
                    immuneIds: ['voting', 'revote'].includes(phase)
                        ? (immunity.get(event.round) || [])
                        : [],
                    eliminated: null,
                    winnerId: event.type === 'vote.revealed' ? null : (event.winnerId ?? null),
                    next: null,
                    note: null,
                });
                continue;
            }
            // Anything that follows belongs to the vote that caused it. The round
            // guard keeps an elimination that no vote produced (a tribe forfeit)
            // from being pinned on the previous round's ballots.
            const chapter = chapters[chapters.length - 1];
            if (!chapter || chapter.round !== event.round) continue;
            switch (event.type) {
                case 'player.eliminated':
                    if (!chapter.eliminated) chapter.eliminated = { ...event };
                    break;
                case 'revote.started':
                    chapter.next = { kind: 'revote', ids: event.tiedIds || [] };
                    break;
                case 'deadlock.started':
                    chapter.next = { kind: 'deadlock', ids: event.tiedIds || [] };
                    break;
                case 'fire_making.started':
                    chapter.next = { kind: 'fire-making', ids: event.contestantIds || [] };
                    break;
                case 'rocks.drawn':
                    chapter.note = `${event.eliminatedId} drew the purple rock.`;
                    break;
                case 'fire_making.completed':
                    chapter.note = `${event.winnerId} won the fire-making tiebreak.`;
                    break;
                case 'vote.no_voter_tiebreak':
                    chapter.note = 'Nobody was left to break the tie, so it was drawn at random.';
                    break;
                case 'jury.three_way_tie':
                    chapter.note = 'The jury split three ways and the win was drawn at random.';
                    chapter.winnerId = event.winnerId ?? chapter.winnerId;
                    break;
                case 'season.completed':
                    chapter.winnerId = event.winnerId ?? chapter.winnerId;
                    break;
                default:
                    break;
            }
        }
        return chapters;
    }

    function chapterStats(chapter) {
        const voterIds = Object.keys(chapter.ballots);
        const counts = chapter.counts;
        const high = Math.max(0, ...Object.values(counts));
        const leaderIds = Object.keys(counts).filter(id => counts[id] === high);
        // Whoever the ballots actually decided against (or crowned). With a tie
        // there is no such player until the revote settles it.
        const decisiveId = chapter.eliminated?.playerId
            || chapter.winnerId
            || (leaderIds.length === 1 ? leaderIds[0] : null);
        const bootId = chapter.eliminated?.playerId || null;
        const bootTargetId = bootId ? chapter.ballots[bootId] : null;
        return {
            voterIds,
            counts,
            leaderIds,
            decisiveId,
            bootTargetId,
            withMajority: voterIds.filter(id => chapter.ballots[id] === decisiveId).length,
            spread: Object.values(counts).sort((left, right) => right - left).join('–'),
            // A forfeited ballot is already reported as never voted, so it is not
            // also counted as a vote that came without an explanation.
            unexplained: voterIds.filter(id =>
                !chapter.reasons?.[id] && !chapter.forfeitedIds.has(id)).length,
            unanimous: leaderIds.length === 1 && high === voterIds.length && voterIds.length > 1,
            tied: leaderIds.length > 1,
            // The boot was aiming at someone who never came for them, and still
            // took a majority: they had no idea it was coming.
            blindside: Boolean(bootId && bootTargetId
                && chapter.ballots[bootTargetId] !== bootId
                && counts[bootId] > voterIds.length / 2),
        };
    }

    function resultsSubLine(chapter, stats) {
        const parts = [`${stats.voterIds.length} ballot${stats.voterIds.length === 1 ? '' : 's'}`];
        if (stats.spread) parts.push(stats.spread);
        if (chapter.forfeitedIds.size) parts.push(`${chapter.forfeitedIds.size} never voted`);
        if (stats.unexplained) parts.push(`${stats.unexplained} gave no reason`);
        return parts.join(' · ');
    }

    function chip(text, tone = '', title = '') {
        return `<span class="chip ${tone}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;
    }

    function bootCardHtml(chapter, stats) {
        if (chapter.winnerId) {
            return `<div class="boot-card win">
                ${avatarHtml(chapter.winnerId, { mode: 'body', scale: 4 })}
                <div class="boot-label">Sole Survivor</div>
                <div class="boot-name">${esc(chapter.winnerId)}</div>
                <div class="boot-meta">${stats.withMajority} of ${stats.voterIds.length} votes to win</div>
                <div class="boot-badges">
                    ${stats.unanimous ? chip('unanimous jury', 'amber') : ''}
                    ${chapter.note ? chip(chapter.note, 'amber') : ''}
                </div>
            </div>`;
        }

        const boot = chapter.eliminated;
        if (!boot) {
            const next = chapter.next;
            const label = next?.kind === 'revote' ? 'Revote'
                : next?.kind === 'deadlock' ? 'Deadlock'
                    : next?.kind === 'fire-making' ? 'Fire-making' : 'No result';
            return `<div class="boot-card safe">
                <div class="boot-label">Tied</div>
                <div class="boot-name">${esc(label)}</div>
                <div class="boot-meta">${esc(names(next?.ids) || 'nobody')} deadlocked at
                    ${stats.counts[stats.leaderIds[0]] ?? 0} votes each</div>
            </div>`;
        }

        const reasonLabel = {
            vote: 'Voted out',
            rocks: 'Drew the purple rock',
            'fire-making': 'Lost at the fire pit',
            'unanimous-deadlock': 'Chosen in the deadlock',
            'no-voter-tiebreak': 'Lost the random draw',
            'tribe-forfeit': 'Tribe forfeit',
        }[boot.reason] || 'Eliminated';

        return `<div class="boot-card">
            ${avatarHtml(boot.playerId, { mode: 'body', scale: 4 })}
            <div class="boot-label">${esc(reasonLabel)}</div>
            <div class="boot-name">${esc(boot.playerId)}</div>
            ${boot.placement ? `<div class="boot-meta">${esc(ordinal(boot.placement))} out of the game</div>` : ''}
            <div class="boot-meta">${stats.bootTargetId
                ? `Their own vote: ${esc(stats.bootTargetId)}`
                : 'Cast no ballot'}</div>
            <div class="boot-badges">
                ${stats.unanimous ? chip('unanimous', 'danger') : ''}
                ${stats.blindside ? chip('blindside', 'danger',
                    'Took a majority while voting for someone who never voted for them') : ''}
                ${boot.joinsJury ? chip('joins the jury', 'amber') : ''}
                ${chapter.note ? chip(chapter.note) : ''}
            </div>
        </div>`;
    }

    function tallyHtml(chapter, stats) {
        const entries = Object.entries(stats.counts)
            .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
        if (!entries.length) return '<div class="empty">No ballots were read.</div>';
        const high = Math.max(1, ...entries.map(entry => entry[1]));
        const safe = chapter.immuneIds.length
            ? `<div class="tally-safe">Safe with immunity: ${esc(names(chapter.immuneIds))}</div>`
            : '';
        return safe + entries.map(([targetId, count]) => {
            const voters = stats.voterIds.filter(id => chapter.ballots[id] === targetId);
            return `<div class="tally-line ${targetId === stats.decisiveId ? 'out' : ''}">
                ${avatarHtml(targetId, { scale: 4 })}
                <div>
                    <div class="who">${esc(targetId)}</div>
                    <div class="tally-track"><span style="width:${Math.round((count / high) * 100)}%"></span></div>
                    <div class="tally-voters">${voters.map(id => avatarHtml(id, { scale: 3 })).join('')}</div>
                </div>
                <div class="num">${count}</div>
            </div>`;
        }).join('');
    }

    function ballotsHtml(chapter, stats) {
        if (!stats.voterIds.length) return '<div class="empty">No ballots were read.</div>';
        // Blocs read together: the pile that decided the vote comes first.
        const ordered = [...stats.voterIds].sort((left, right) =>
            (stats.counts[chapter.ballots[right]] || 0) - (stats.counts[chapter.ballots[left]] || 0)
            || left.localeCompare(right)
        );
        return ordered.map(voterId => {
            const targetId = chapter.ballots[voterId];
            const forfeited = chapter.forfeitedIds.has(voterId);
            const reason = chapter.reasons?.[voterId];
            const side = stats.decisiveId
                ? (targetId === stats.decisiveId ? 'majority' : 'minority')
                : '';
            const said = forfeited
                ? '<div class="ballot-say none">Never voted. The clock filled this ballot in at random.</div>'
                : reason
                    ? `<div class="ballot-say">“${esc(reason)}”</div>`
                    : '<div class="ballot-say none">Voted without giving a reason.</div>';
            return `<div class="ballot ${side} ${forfeited ? 'autofilled' : ''}">
                <div class="ballot-who">
                    ${avatarHtml(voterId, { scale: 4 })}<span>${esc(voterId)}</span>
                </div>
                <div class="arrow">→</div>
                <div class="ballot-who">
                    ${avatarHtml(targetId, { scale: 4 })}<span>${esc(targetId)}</span>
                </div>
                ${said}
            </div>`;
        }).join('');
    }

    function renderVoteResults(game) {
        const chapters = voteChapters(game);
        const panel = el('voteResults');
        panel.hidden = chapters.length === 0;
        if (!chapters.length) return;
        if (resultsFollow || resultsPick == null || resultsPick >= chapters.length) {
            resultsPick = chapters.length - 1;
        }
        const chapter = chapters[resultsPick];
        const stats = chapterStats(chapter);
        const isFinal = ['jury_voting', 'finalist_tiebreak'].includes(chapter.phase);
        const latest = resultsPick === chapters.length - 1;
        panel.classList.toggle('fresh', latest && chapter.round === game.round);

        el('resultsTitle').textContent = chapter.phase === 'jury_voting'
            ? 'The jury votes'
            : chapter.phase === 'finalist_tiebreak'
                ? 'The deciding vote'
                : `Round ${chapter.round} · the vote${chapter.phase === 'revote' ? ' (revote)' : ''}`;
        el('resultsSub').textContent = resultsSubLine(chapter, stats);
        el('resultsTallyLabel').textContent = isFinal ? 'Votes to win' : 'Votes against';
        el('resultsTabs').innerHTML = chapters.map((item, index) => `
            <button type="button" class="results-tab ${index === resultsPick ? 'on' : ''}"
                data-index="${index}">${esc(chapterTab(item))}</button>`).join('');
        el('resultsBoot').innerHTML = bootCardHtml(chapter, stats);
        el('resultsTally').innerHTML = tallyHtml(chapter, stats);
        el('resultsBallots').innerHTML = ballotsHtml(chapter, stats);
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
        // Baseline games first; experimental contests stay available but labeled.
        const baselineIds = new Set([
            'cake_race', 'death_race', 'dog_race', 'diamond_race', 'netherite_race',
            'tower_battle', 'deepest_2_5', 'deepest_5', 'spleef',
        ]);
        const sorted = [...games].sort((left, right) => {
            const leftBase = baselineIds.has(left.id) ? 0 : 1;
            const rightBase = baselineIds.has(right.id) ? 0 : 1;
            return leftBase - rightBase || left.title.localeCompare(right.title);
        });
        el('deckAddSelect').innerHTML = sorted
            .map(game => {
                const tag = baselineIds.has(game.id) ? '' : ' (experimental)';
                return `<option value="${esc(game.id)}">${esc(game.title)}${tag}</option>`;
            })
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
        const cheapSixButton = el('startCheapSixTestBtn');
        const game = currentGame();
        const ready = profiles.length > 0 && scenarios.length > 0;
        const cheapProfile = profiles.find(profile => profile.id === CHEAP_TEST_PROFILE_ID);
        const cheapScenario = scenarios.find(scenario => scenario.scenarioId === CHEAP_TEST_SCENARIO_ID);
        const cheapSixScenario = scenarios.find(
            scenario => scenario.scenarioId === CHEAP_SIX_TEST_SCENARIO_ID
        );
        button.disabled = !ready || gameSetup?.isBusy();
        cheapButton.disabled = !cheapProfile || !cheapScenario || gameSetup?.isBusy();
        cheapSixButton.disabled = !cheapProfile || !cheapSixScenario || gameSetup?.isBusy();
        cheapButton.title = cheapProfile
            ? `Four bots using ${cheapProfile.name} (${cheapProfile.model})`
            : 'GPT-5.6 Luna Instant is not configured';
        cheapSixButton.title = cheapProfile
            ? `Six bots using ${cheapProfile.name} (${cheapProfile.model})`
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
            lineupId: options.profileId ? null : defaultBotModelLineupId,
            preferredParticipantCount: Number(scenario?.castSize) || characters.length || 4,
            hideModelLineup: Boolean(options.profileId),
            participants,
            duration: null,
            minParticipants: Number(scenario?.minimumPlayers) || 4,
            minParticipantsError: scenario?.maximumPlayers === scenario?.minimumPlayers
                ? `${scenario.title} requires exactly ${scenario.minimumPlayers} starting bots`
                : `Survivor needs at least ${Number(scenario?.minimumPlayers) || 4} starting bots`,
            maxParticipants: Number(scenario?.maximumPlayers) || null,
            maxParticipantsError: scenario?.maximumPlayers
                ? `${scenario.title} requires exactly ${scenario.maximumPlayers} starting bots`
                : null,
            fields: [
                { id: 'mergeAt', label: 'Merge remaining', min: 4, max: 10, step: 1, value: scenario?.mergeAt || 10 },
                {
                    id: 'strategyMinutes',
                    label: 'Strategy min',
                    min: 0.5,
                    max: 10,
                    step: 0.5,
                    value: (scenario?.phaseDurationsMs?.strategy || 600_000) / 60_000,
                },
                {
                    id: 'councilMinutes',
                    label: 'Council min',
                    min: 0.5,
                    max: 10,
                    step: 0.5,
                    value: (scenario?.phaseDurationsMs?.tribalCouncil || 300_000) / 60_000,
                },
            ],
            validate: ({ fields }) => {
                if (!Number.isInteger(fields.mergeAt) || fields.mergeAt < 4 || fields.mergeAt > 10) {
                    return 'Survivor merge count must be from 4 to 10';
                }
                return null;
            },
            buildRequest: ({
                participants,
                systemPrompt,
                fields,
                recordingEnabled,
                autoRecordingEnabled,
            }) => ({
                event: 'survivor-start',
                payload: {
                    participants,
                    systemPrompt,
                    recordingEnabled,
                    autoRecordingEnabled,
                    scenarioId: scenario?.scenarioId,
                    mergeAt: fields.mergeAt,
                    councilAutoAdvance: el('councilAutoAdvance').checked,
                    phaseDurationsMs: {
                        strategy: fields.strategyMinutes * 60_000,
                        tribal_council: fields.councilMinutes * 60_000,
                        // Voting stays host-held; never start a vote clock.
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

    function openCheapTest(scenarioId) {
        const scenario = scenarios.find(item => item.scenarioId === scenarioId);
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
            title: `Set up cheap ${scenario.castSize}-bot Survivor test`,
            footer: `All ${scenario.castSize} bots use ${profile.name} with instant/no reasoning—the lowest-cost model profile available here. Review the cast, then start.`,
        });
    }

    // —— Wiring ——————————————————————————————————————————————————

    gameSetup = window.createGameSetup({
        socket,
        getProfiles: () => profiles,
        getBotModelLineups: () => botModelLineups,
        getBotPersonas: () => botPersonas,
        getDefaultBotModelLineupId: () => defaultBotModelLineupId,
        getReservedNames: reservedNames,
        onStatus: setStatus,
        onBusyChange: () => updateStartButton(),
    });

    el('startSeasonBtn').addEventListener('click', openSeasonSetup);
    el('startCheapTestBtn').addEventListener('click', () =>
        openCheapTest(CHEAP_TEST_SCENARIO_ID)
    );
    el('startCheapSixTestBtn').addEventListener('click', () =>
        openCheapTest(CHEAP_SIX_TEST_SCENARIO_ID)
    );
    el('scenarioSelect').addEventListener('change', renderScenarioBlurb);
    el('pauseBtn').addEventListener('click', () => control(state?.paused ? 'resume' : 'pause'));
    el('parkBtn').addEventListener('click', () => {
        if (window.confirm(
            'Park the season? Bots leave the world so other games can run. '
            + 'The season waits here until you unpark and restore the cast.'
        )) {
            control('park', { reason: 'Parked from the Survivor control room' });
        }
    });
    el('resumeSeasonBtn').addEventListener('click', () => control('unpark'));
    el('discardSeasonBtn').addEventListener('click', () => {
        if (window.confirm('Cancel the parked season for good?')) {
            control('cancel', { reason: 'Cancelled from the Survivor control room' });
        }
    });
    el('advanceBtn').addEventListener('click', () => {
        if (currentGame()?.phase === 'fire_making') {
            if (!window.confirm(
                'Resolve fire-making with a random winner? Cancel if you want to pick a winner another way.'
            )) {
                return;
            }
            control('fire-result', { confirm: true });
            return;
        }
        control('advance');
    });
    el('revealVotesBtn').addEventListener('click', () => control('reveal-votes'));
    el('harnessSetImmunityBtn').addEventListener('click', () =>
        control('set-immunity', harnessPayload())
    );
    el('harnessDeclareWinnerBtn').addEventListener('click', () => {
        const game = currentGame();
        const payload = harnessPayload();
        const label = game?.merged
            ? payload.winnerId
            : `${payload.winningTribe} (via ${payload.winnerId})`;
        if (!window.confirm(
            `Declare challenge winner: ${label}? This ends the live contest and awards immunity.`
        )) {
            return;
        }
        control('challenge-result', payload);
    });
    el('harnessSkipChallengeBtn').addEventListener('click', () =>
        control('skip-challenge', harnessPayload())
    );
    el('harnessJumpCouncilBtn').addEventListener('click', () =>
        control('jump-to-council', harnessPayload())
    );
    el('harnessForceMeetBtn')?.addEventListener('click', () => {
        const a = el('harnessImmuneSelect').value;
        const b = el('harnessMeetSelect').value;
        if (!a || !b || a === b) {
            setStatus('Pick two different players for a forced private meet', true);
            return;
        }
        control('force-private-meet', {
            memberIds: [a, b],
            pitch: 'Host-forced private meet for the harness.',
        });
    });
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
    // Delegated, because the tabs are rebuilt on every state update. Stepping
    // back to an earlier vote stops the panel from jumping to the next reveal.
    el('resultsTabs').addEventListener('click', event => {
        const tab = event.target.closest('.results-tab');
        if (!tab) return;
        const chapters = voteChapters(currentGame() || {});
        resultsPick = Number(tab.dataset.index);
        resultsFollow = resultsPick >= chapters.length - 1;
        render();
    });
    el('holdPhaseBtn').addEventListener('click', () => control('set-phase-deadline', { seconds: null }));
    el('rushPhaseBtn').addEventListener('click', () => control('set-phase-deadline', { seconds: 5 }));
    el('copyDiagBtn').addEventListener('click', copyDiagnostics);
    el('voiceAlertDismiss').addEventListener('click', async () => {
        el('voiceAlert').hidden = true;
        // Clear it server-side too, so the next real failure reports fresh
        // instead of being swallowed by the report cooldown.
        try {
            await fetch('/api/voice/health/reset', { method: 'POST' });
        } catch (_) {
            // The banner is already hidden; a failed reset is not worth surfacing.
        }
    });

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

    socket.on('voice-health', renderVoiceHealth);

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

    // —— Voice mute / flush ——————————————————————————————————————

    let voiceMuteMode = 'off';

    function renderMuteButtons() {
        const soft = el('softMuteBtn');
        const hard = el('hardMuteBtn');
        if (!soft || !hard) return;
        soft.textContent = voiceMuteMode === 'soft' ? 'Soft mute on' : 'Soft mute';
        hard.textContent = voiceMuteMode === 'hard' ? 'Hard mute on' : 'Hard mute';
        soft.classList.toggle('btn-amber', voiceMuteMode === 'soft');
        hard.classList.toggle('btn-danger', voiceMuteMode === 'hard');
    }

    async function setVoiceMuteMode(mode) {
        const next = voiceMuteMode === mode ? 'off' : mode;
        const response = await fetch(`/api/voice/mute?mode=${encodeURIComponent(next)}`, {
            method: 'POST',
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || body.success === false) {
            setStatus(body.error || 'Could not change mute');
            return;
        }
        voiceMuteMode = body.mode || next;
        renderMuteButtons();
    }

    el('softMuteBtn').addEventListener('click', () => setVoiceMuteMode('soft'));
    el('hardMuteBtn').addEventListener('click', () => setVoiceMuteMode('hard'));
    el('flushVoiceBtn').addEventListener('click', async () => {
        await fetch('/api/voice/flush', { method: 'POST' });
        setStatus('Voice queue flushed.');
    });
    socket.on('voice-mute', payload => {
        voiceMuteMode = payload?.mode || (payload?.muted ? 'hard' : 'off');
        renderMuteButtons();
    });
    fetch('/api/voice/mute').then(r => r.json()).then(body => {
        if (body?.mode) voiceMuteMode = body.mode;
        else if (body?.muted) voiceMuteMode = 'hard';
        renderMuteButtons();
    }).catch(() => {});

    if (typeof window.initBotVoice === 'function') window.initBotVoice(socket);
})();
