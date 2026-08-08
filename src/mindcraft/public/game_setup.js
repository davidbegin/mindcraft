// Roster picker shared by the games dashboard and the Survivor control room.
// It owns its own modal markup so a page only has to describe the game it wants
// to start; see game_setup.css for the styles.
(function () {
    const AGENT_NAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;
    const MAX_SYSTEM_PROMPT = 4000;
    const MIN_DURATION_MINUTES = 0.5;
    const MAX_DURATION_MINUTES = 60;
    // A cold launch spawns every bot, waits up to 90s for them to join, resets the
    // arena, and starts a camera per angle, so the ack legitimately arrives minutes
    // later. This is only a backstop now that a stalled ack no longer fails the launch.
    const START_TIMEOUT_MS = 360_000;

    function esc(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function sanitizeMinecraftName(value) {
        return String(value || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 16);
    }

    function nextUniqueMinecraftName(baseName, reserved) {
        const cleaned = sanitizeMinecraftName(baseName) || 'bot';
        const base = cleaned.length >= 3 ? cleaned : `${cleaned}bot`.slice(0, 16);
        if (!reserved.has(base) && AGENT_NAME_PATTERN.test(base)) return base;
        for (let suffix = 2; suffix < 1000; suffix++) {
            const suffixText = String(suffix);
            const candidate = `${base.slice(0, 16 - suffixText.length)}${suffixText}`;
            if (!reserved.has(candidate) && AGENT_NAME_PATTERN.test(candidate)) return candidate;
        }
        throw new Error(`Could not generate a unique name for ${baseName}`);
    }

    // Mirrors autoVoiceName() in src/agent/tts_voices.js for bots the server has
    // never seen, so the "Auto" option shows the voice they will actually get.
    function autoVoiceFor(name, pool) {
        if (!pool?.length) return '';
        const text = String(name || 'bot');
        let hash = 5381;
        for (let i = 0; i < text.length; i++) {
            hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
        }
        return pool[hash % pool.length].name;
    }

    const MODAL_HTML = `
        <div class="modal game-setup-modal">
            <div class="modal-header">
                <h2 data-el="title">Set up game</h2>
                <button type="button" class="btn btn-danger" data-action="close">Close</button>
            </div>
            <div class="modal-body">
                <div class="game-setup-teams" data-el="teams" hidden>
                    <label>Team 1
                        <input type="text" maxlength="16" spellcheck="false" data-team-name="0">
                    </label>
                    <label>Team 2
                        <input type="text" maxlength="16" spellcheck="false" data-team-name="1">
                    </label>
                </div>
                <div class="game-setup-lineup" data-el="lineupRow">
                    <label data-el="lineupLabel">Model pack
                        <select data-el="lineupSelect" aria-label="Bot model pack"></select>
                    </label>
                    <p class="games-sub" data-el="lineupBlurb"></p>
                </div>
                <div class="game-setup-participants" data-el="participants"></div>
                <div class="game-setup-voice-status" data-el="voiceStatus"></div>
                <div class="game-setup-actions">
                    <button type="button" class="btn btn-ghost" data-action="add">+ Add participant</button>
                </div>
                <div class="game-setup-duration" data-el="duration">
                    <label data-el="durationLabel">Duration (minutes)</label>
                    <input type="number" min="0.5" max="60" step="0.5" inputmode="decimal" data-el="durationInput">
                    <span class="games-sub">0.5–60 minutes</span>
                </div>
                <div class="game-setup-duration" data-el="fields" hidden></div>
                <div class="game-setup-recording">
                    <label>
                        <input type="checkbox" data-el="recordingEnabled">
                        <span>
                            <strong>Record gameplay</strong>
                            <small>Capture the full game. Uses substantially more CPU and storage.</small>
                        </span>
                    </label>
                    <label>
                        <input type="checkbox" data-el="autoRecordingEnabled">
                        <span>
                            <strong>Auto-record actions</strong>
                            <small>Save shorter clips when bots are active.</small>
                        </span>
                    </label>
                    <div class="games-sub">Recording is off by default. Choose at most one mode.</div>
                </div>
                <div class="game-setup-prompt">
                    <label data-el="promptLabel">Match-wide system prompt (optional)</label>
                    <textarea maxlength="4000" rows="4" spellcheck="true" data-el="systemPrompt"
                        placeholder="Extra instructions for every temporary contest bot…"></textarea>
                    <div class="game-setup-prompt-count"><span data-el="promptCount">0</span>/4000</div>
                </div>
                <div class="game-setup-error error" data-el="error"></div>
                <div class="launch-debug-report" data-el="debug" hidden>
                    <div class="launch-debug-report-head">
                        <strong>Debug report for Cursor</strong>
                        <div class="launch-debug-report-actions">
                            <button type="button" class="btn btn-primary" data-action="copy-report">Copy for Cursor</button>
                        </div>
                    </div>
                    <textarea readonly spellcheck="false" data-el="debugText"
                        aria-label="Launch failure debug report"></textarea>
                </div>
            </div>
            <div class="modal-footer">
                <div class="footer-left" data-el="footer">Pick profiles and unique Minecraft names, then start.</div>
                <div class="footer-actions">
                    <button type="button" class="btn btn-ghost" data-action="cancel">Cancel</button>
                    <button type="button" class="btn btn-primary" data-action="submit">Start game</button>
                </div>
            </div>
        </div>
    `;

    window.createGameSetup = function createGameSetup(options = {}) {
        const socket = options.socket;
        if (!socket) throw new Error('createGameSetup requires a socket');
        const getProfiles = options.getProfiles || (() => []);
        const getReservedNames = options.getReservedNames || (() => []);
        const getBotModelLineups = options.getBotModelLineups || (() => []);
        const getBotPersonas = options.getBotPersonas || (() => []);
        const getDefaultBotModelLineupId = options.getDefaultBotModelLineupId || (() => 'variety');
        const onStatus = options.onStatus || (() => {});
        const onBusyChange = options.onBusyChange || (() => {});
        const onLaunchReport = options.onLaunchReport || (() => {});
        // A launch outlives this dialog: a connection blip hands the roster back
        // while MindServer keeps going, and starting again from that roster only
        // gets refused. The page tells us when a launch is still out there.
        const getLaunchInProgress = options.getLaunchInProgress || (() => null);

        const backdrop = document.createElement('div');
        backdrop.className = 'modal-backdrop';
        backdrop.innerHTML = MODAL_HTML;
        document.body.appendChild(backdrop);

        const el = name => backdrop.querySelector(`[data-el="${name}"]`);
        const action = name => backdrop.querySelector(`[data-action="${name}"]`);

        let config = null;
        let participants = [];
        let voices = null;
        let previewAudio = null;
        let busy = false;
        let lastReport = '';
        let teamNames = [];
        let selectedLineupId = 'variety';
        // Bumped per launch so a late ack from an abandoned launch cannot
        // overwrite the state of whatever the roster is doing now.
        let launchId = 0;

        function configuredProfiles() {
            return getProfiles().filter(profile => profile?.id && profile.configured !== false);
        }

        // The catalog lists a model family's effort presets together, fastest first, so
        // walking it in order fills a roster with one model at six speeds. Taking one
        // profile per family in turn instead gives every slot a different model and picks
        // its quickest setting first.
        function profilesByFamily(profiles) {
            const families = new Map();
            for (const profile of profiles) {
                const family = profile.family || profile.id;
                if (!families.has(family)) families.set(family, []);
                families.get(family).push(profile);
            }
            const lists = [...families.values()];
            const ordered = [];
            for (let round = 0; ordered.length < profiles.length; round++) {
                for (const list of lists) {
                    if (round < list.length) ordered.push(list[round]);
                }
            }
            return ordered;
        }

        function reservedNames(exceptIndex = -1) {
            const names = new Set(getReservedNames());
            participants.forEach((participant, index) => {
                if (index === exceptIndex) return;
                const name = sanitizeMinecraftName(participant.name);
                if (name) names.add(name);
            });
            return names;
        }

        function setError(message, { scroll = false } = {}) {
            const node = el('error');
            node.textContent = message || '';
            node.classList.toggle('error', Boolean(message));
            // Validation messages live at the bottom of a tall roster; bring them
            // into view and mirror into the always-visible footer so Start does
            // not look like a silent no-op.
            if (message && scroll) {
                node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                el('footer').textContent = message;
            }
        }

        function logSetup(level, message, detail) {
            const line = `[game-setup] ${message}`;
            if (level === 'error') console.error(line, detail ?? '');
            else if (level === 'warn') console.warn(line, detail ?? '');
            else console.info(line, detail ?? '');
        }

        function setVoiceStatus(message, isError = false) {
            const node = el('voiceStatus');
            node.textContent = message || '';
            node.classList.toggle('error', Boolean(isError));
        }

        function setBusy(next) {
            busy = next;
            action('submit').disabled = next;
            onBusyChange(next);
        }

        function findLineup(lineupId) {
            const lineups = getBotModelLineups();
            return lineups.find(item => item.id === lineupId)
                || lineups.find(item => item.id === getDefaultBotModelLineupId())
                || lineups[0]
                || null;
        }

        // Personas stay fixed; only profileIds come from the pack. Count follows the
        // pack unless the game needs more seats (team minimum / Survivor cast size).
        function charactersFromLineup(lineupId, count) {
            const lineup = findLineup(lineupId);
            const personas = getBotPersonas();
            if (!lineup?.profileIds?.length || !personas.length) return null;
            let total = Number.isFinite(count) && count > 0 ? Math.floor(count) : lineup.profileIds.length;
            if (config?.minParticipants && total < config.minParticipants) {
                total = config.minParticipants;
            }
            if (config?.maxParticipants && total > config.maxParticipants) {
                total = config.maxParticipants;
            }
            if (total > personas.length) total = personas.length;
            // Survivor's variety pack drops glm and adds four overflow models.
            const profileIds = total >= 11 && lineup.survivorProfileIds?.length
                ? lineup.survivorProfileIds
                : lineup.profileIds;
            return Array.from({ length: total }, (_, index) => {
                const persona = personas[index];
                return {
                    name: persona.name,
                    voice: persona.voice || null,
                    systemPrompt: persona.systemPrompt || '',
                    profileId: profileIds[index % profileIds.length],
                };
            });
        }

        function applySelectedLineup({ preserveCount = false } = {}) {
            // Pack length is the showcase size; cake/tower prefer a shorter variety
            // cast via preferredParticipantCount. Team/Survivor mins still pad up.
            let count = null;
            if (preserveCount) {
                count = participants.length;
            } else if (
                selectedLineupId === getDefaultBotModelLineupId()
                && Number.isFinite(config?.preferredParticipantCount)
            ) {
                count = config.preferredParticipantCount;
            }
            const characters = charactersFromLineup(selectedLineupId, count);
            if (!characters?.length) return false;
            participants = defaultParticipantsFor(characters, characters.length);
            if (config?.teams) {
                participants.forEach((participant, index) => {
                    participant.team = teamNames[index % teamNames.length];
                });
            }
            return true;
        }

        function renderLineup() {
            const lineups = getBotModelLineups();
            const row = el('lineupRow');
            const select = el('lineupSelect');
            const blurb = el('lineupBlurb');
            if (!lineups.length || config?.hideModelLineup) {
                row.hidden = true;
                return;
            }
            row.hidden = false;
            if (!lineups.some(item => item.id === selectedLineupId)) {
                selectedLineupId = getDefaultBotModelLineupId();
            }
            select.innerHTML = lineups.map(lineup =>
                `<option value="${esc(lineup.id)}"${lineup.id === selectedLineupId ? ' selected' : ''}>${esc(lineup.title)} (${lineup.profileIds.length})</option>`
            ).join('');
            const current = findLineup(selectedLineupId);
            blurb.textContent = current?.blurb || '';
        }

        function defaultParticipantsFor(characters, count) {
            const profiles = configuredProfiles();
            if (!profiles.length) return [];
            const rotation = profilesByFamily(profiles);
            const reserved = new Set(getReservedNames());
            const rows = [];
            const total = count || characters?.length || Math.min(2, profiles.length);
            // A cast can be larger than the character list (Survivor seats eleven), so
            // the unnamed slots take families the characters left unused before any
            // family repeats at a slower effort.
            const usedFamilies = new Set();
            for (let i = 0; i < total; i++) {
                const character = characters?.[i] || null;
                const profile = profiles.find(item => item.id === character?.profileId)
                    || rotation.find(item => !usedFamilies.has(item.family || item.id))
                    || rotation[i % rotation.length];
                usedFamilies.add(profile.family || profile.id);
                const name = character
                    ? sanitizeMinecraftName(character.name)
                    : nextUniqueMinecraftName(profile.name || profile.id || 'bot', reserved);
                reserved.add(name);
                rows.push({
                    profileId: profile.id,
                    name,
                    voice: character?.voice || null,
                    systemPrompt: character?.systemPrompt || '',
                });
            }
            return rows;
        }

        function effectiveVoice(participant) {
            if (participant.voice) return participant.voice;
            if (!voices) return null;
            return voices.config?.bots?.[participant.name]
                || voices.config?.default_voice
                || autoVoiceFor(participant.name, voices.pool);
        }

        function voiceOptionsHtml(participant) {
            if (!voices) return '<option value="">Loading voices…</option>';
            const automatic = effectiveVoice({ ...participant, voice: null });
            return [
                `<option value="" ${participant.voice ? '' : 'selected'}>Auto — ${esc(automatic)}</option>`,
                ...voices.pool.map(voice =>
                    `<option value="${esc(voice.name)}" ${participant.voice === voice.name ? 'selected' : ''}>${esc(voice.name)} — ${esc(voice.description)}</option>`
                ),
            ].join('');
        }

        function nameHint(name) {
            if (!name) return 'Name required (3–16 letters, numbers, or underscores)';
            if (!AGENT_NAME_PATTERN.test(name)) return 'Use 3–16 letters, numbers, or underscores';
            return null;
        }

        function playPreview(voice, botName, button) {
            if (!voice) return;
            if (previewAudio) { previewAudio.pause(); previewAudio = null; }
            button.disabled = true;
            button.textContent = '…';
            setVoiceStatus('Generating preview…');
            socket.timeout(20_000).emit('preview-voice', { voice, botName }, (err, res) => {
                button.disabled = !voices?.previewAvailable;
                button.textContent = '▶';
                if (err || !res?.success) {
                    setVoiceStatus(
                        `Preview failed: ${err ? 'no response from the server' : res?.error || 'unknown error'}`,
                        true
                    );
                    return;
                }
                setVoiceStatus('');
                previewAudio = new Audio(`data:audio/mpeg;base64,${res.audio}`);
                previewAudio.play().catch(error =>
                    setVoiceStatus(`Could not play audio: ${error.message}`, true)
                );
            });
        }

        function renderParticipants() {
            const box = el('participants');
            const profiles = configuredProfiles();
            box.replaceChildren();
            action('add').disabled = Boolean(
                config?.maxParticipants && participants.length >= config.maxParticipants
            );

            participants.forEach((participant, index) => {
                const row = document.createElement('div');
                row.className = `game-setup-row${config?.teams ? ' has-teams' : ''}`;
                const reserved = reservedNames(index);
                const duplicate = AGENT_NAME_PATTERN.test(participant.name || '')
                    && reserved.has(participant.name);
                const hint = nameHint(participant.name) || (duplicate ? 'Name is already taken' : 'Minecraft-safe name');
                const invalid = Boolean(nameHint(participant.name)) || duplicate;
                const profileOptions = profiles.map(profile => {
                    const label = `${profile.name} — ${profile.model}${profile.provider ? ` (${profile.provider})` : ''}`;
                    return `<option value="${esc(profile.id)}"${profile.id === participant.profileId ? ' selected' : ''}>${esc(label)}</option>`;
                }).join('');
                const teamOptions = teamNames.map(name =>
                    `<option value="${esc(name)}"${participant.team === name ? ' selected' : ''}>${esc(name)}</option>`
                ).join('');

                row.innerHTML = `
                    <select data-field="profileId" aria-label="Participant profile">${profileOptions || '<option value="">No profiles</option>'}</select>
                    <input type="text" data-field="name" maxlength="16" spellcheck="false"
                        class="${invalid ? 'invalid' : ''}"
                        value="${esc(participant.name || '')}" aria-label="Participant name">
                    ${config?.teams
                        ? `<select data-field="team" aria-label="Team for ${esc(participant.name || `participant ${index + 1}`)}">${teamOptions}</select>`
                        : ''}
                    <div class="game-setup-voice">
                        <select data-field="voice" aria-label="Voice for ${esc(participant.name || `participant ${index + 1}`)}"
                            ${voices ? '' : 'disabled'}>${voiceOptionsHtml(participant)}</select>
                        <button type="button" class="btn btn-ghost btn-preview" data-action="preview-voice"
                            ${voices?.previewAvailable ? '' : 'disabled'}
                            title="${voices?.previewAvailable ? 'Preview this voice' : 'Voice preview unavailable'}">▶</button>
                    </div>
                    <button type="button" class="btn btn-ghost" data-action="remove" ${participants.length <= 1 ? 'disabled' : ''}>Remove</button>
                    <div class="name-hint ${invalid ? 'error' : ''}">${esc(hint)}</div>
                    <textarea data-field="systemPrompt" class="personality-prompt" maxlength="${MAX_SYSTEM_PROMPT}"
                        rows="3" aria-label="System prompt for ${esc(participant.name || `participant ${index + 1}`)}"
                        placeholder="Give this bot a personality…">${esc(participant.systemPrompt || '')}</textarea>
                `;

                row.querySelector('[data-field="profileId"]').addEventListener('change', event => {
                    const profile = profiles.find(item => item.id === event.target.value);
                    participants[index].profileId = event.target.value;
                    if (profile) {
                        participants[index].name = nextUniqueMinecraftName(
                            profile.name || profile.id || 'bot',
                            reservedNames(index)
                        );
                    }
                    renderParticipants();
                });

                const nameInput = row.querySelector('[data-field="name"]');
                nameInput.addEventListener('input', event => {
                    const input = event.target;
                    const cursor = input.selectionStart;
                    const cleaned = sanitizeMinecraftName(input.value);
                    participants[index].name = cleaned;
                    if (input.value !== cleaned) {
                        input.value = cleaned;
                        const nextCursor = Math.min(cursor, cleaned.length);
                        input.setSelectionRange(nextCursor, nextCursor);
                    }
                    const takenNow = AGENT_NAME_PATTERN.test(cleaned) && reservedNames(index).has(cleaned);
                    const problem = nameHint(cleaned) || (takenNow ? 'Name is already taken' : null);
                    input.classList.toggle('invalid', Boolean(problem));
                    const hintNode = row.querySelector('.name-hint');
                    hintNode.classList.toggle('error', Boolean(problem));
                    hintNode.textContent = problem || 'Minecraft-safe name';
                    const automatic = row.querySelector('[data-field="voice"] option[value=""]');
                    if (automatic && !participants[index].voice) {
                        automatic.textContent = `Auto — ${effectiveVoice(participants[index])}`;
                    }
                });

                row.querySelector('[data-field="voice"]').addEventListener('change', event => {
                    participants[index].voice = event.target.value || null;
                });
                row.querySelector('[data-field="team"]')?.addEventListener('change', event => {
                    participants[index].team = event.target.value;
                });

                row.querySelector('[data-field="systemPrompt"]').addEventListener('input', event => {
                    participants[index].systemPrompt = event.target.value;
                });

                row.querySelector('[data-action="preview-voice"]').addEventListener('click', event => {
                    playPreview(
                        effectiveVoice(participants[index]),
                        participants[index].name,
                        event.currentTarget
                    );
                });

                row.querySelector('[data-action="remove"]').addEventListener('click', () => {
                    if (participants.length <= 1) return;
                    participants.splice(index, 1);
                    renderParticipants();
                });

                box.appendChild(row);
            });

            action('add').disabled = profiles.length === 0;
        }

        function renderTeams() {
            const box = el('teams');
            box.hidden = !config?.teams;
            if (!config?.teams) return;
            box.querySelectorAll('[data-team-name]').forEach((input, index) => {
                input.value = teamNames[index] || '';
                input.oninput = event => {
                    const oldName = teamNames[index];
                    const nextName = event.target.value.slice(0, 16);
                    teamNames[index] = nextName;
                    participants.forEach(participant => {
                        if (participant.team === oldName) participant.team = nextName;
                    });
                    renderParticipants();
                };
            });
        }

        function renderFields() {
            const box = el('fields');
            box.replaceChildren();
            const fields = config?.fields || [];
            box.hidden = fields.length === 0;
            for (const field of fields) {
                const label = document.createElement('label');
                label.textContent = field.label;
                label.htmlFor = `gameSetupField-${field.id}`;
                let input;
                if (field.type === 'select' && Array.isArray(field.options)) {
                    input = document.createElement('select');
                    input.id = `gameSetupField-${field.id}`;
                    input.dataset.fieldId = field.id;
                    for (const option of field.options) {
                        const opt = document.createElement('option');
                        opt.value = String(option.value);
                        opt.textContent = option.label ?? String(option.value);
                        if (String(option.value) === String(field.value)) opt.selected = true;
                        input.append(opt);
                    }
                } else {
                    input = document.createElement('input');
                    input.id = `gameSetupField-${field.id}`;
                    input.type = 'number';
                    input.dataset.fieldId = field.id;
                    if (field.min != null) input.min = String(field.min);
                    if (field.max != null) input.max = String(field.max);
                    if (field.step != null) input.step = String(field.step);
                    input.value = String(field.value ?? '');
                }
                box.append(label, input);
            }
        }

        function fieldValues() {
            const values = {};
            // Number fields are <input>; Spleef's best-of (and any future enums)
            // are <select>. Skipping selects made Start fail validation with a
            // message buried under the roster.
            for (const input of el('fields').querySelectorAll('[data-field-id]')) {
                const raw = input.value;
                const asNumber = Number(raw);
                values[input.dataset.fieldId] = Number.isFinite(asNumber) && raw !== ''
                    ? asNumber
                    : raw;
            }
            return values;
        }

        function loadVoices() {
            setVoiceStatus(voices ? '' : 'Loading voice choices…');
            socket.timeout(10_000).emit('get-voices', (err, res) => {
                if (!config) return;
                if (err || !res?.success) {
                    setVoiceStatus(
                        err ? 'Could not load voices from the server.' : res?.error || 'Could not load voices.',
                        true
                    );
                    renderParticipants();
                    return;
                }
                voices = res;
                setVoiceStatus(res.previewAvailable
                    ? 'Choose a voice and press ▶ to hear a sample.'
                    : 'Voice previews require ELEVENLABS_API_KEY.');
                renderParticipants();
            });
        }

        function showReport(report, visible = true) {
            lastReport = String(report || '');
            el('debugText').value = lastReport;
            el('debug').hidden = !(visible && lastReport);
            onLaunchReport(lastReport);
        }

        function fetchLastReport() {
            socket.timeout(8000).emit('diagnostics-report', (err, res) => {
                if (err || !res?.success || !res.report) return;
                showReport(res.report, isVisible());
            });
        }

        function validate() {
            const profileIds = new Set(configuredProfiles().map(profile => profile.id));
            if (!config) return 'No game selected';
            if (!participants.length) return 'Add at least one participant';
            if (config.minParticipants && participants.length < config.minParticipants) {
                return config.minParticipantsError
                    || `This game needs at least ${config.minParticipants} bots`;
            }
            if (config.maxParticipants && participants.length > config.maxParticipants) {
                return config.maxParticipantsError
                    || `This game allows at most ${config.maxParticipants} bots`;
            }
            const seen = new Set();
            const taken = new Set(getReservedNames());
            for (let i = 0; i < participants.length; i++) {
                const participant = participants[i];
                const name = String(participant.name || '').trim();
                if (!AGENT_NAME_PATTERN.test(name)) {
                    return `Participant ${i + 1} name must be 3–16 letters, numbers, or underscores`;
                }
                if (seen.has(name)) return `Participant names must be unique: ${name}`;
                if (taken.has(name)) return `A bot named ${name} is already online. Stop it first.`;
                if (!participant.profileId || !profileIds.has(participant.profileId)) {
                    return `Participant ${i + 1} needs a configured profile`;
                }
                if (String(participant.systemPrompt || '').length > MAX_SYSTEM_PROMPT) {
                    return `Participant ${i + 1} system prompt must be ${MAX_SYSTEM_PROMPT} characters or fewer`;
                }
                seen.add(name);
            }
            if (config.teams) {
                if (teamNames.length !== 2 || teamNames.some(name =>
                    !/^[A-Za-z0-9_ ]{1,16}$/.test(String(name || '').trim())
                )) {
                    return 'Team names must be 1-16 letters, numbers, spaces, or underscores';
                }
                if (teamNames[0].trim().toLowerCase() === teamNames[1].trim().toLowerCase()) {
                    return 'Team names must be different';
                }
                const minimum = config.teams.minimumPlayersPerTeam ?? 2;
                for (const name of teamNames) {
                    const count = participants.filter(participant => participant.team === name).length;
                    if (count < minimum) return `Team ${name} needs at least ${minimum} players`;
                }
            }
            if (el('systemPrompt').value.length > MAX_SYSTEM_PROMPT) {
                return `System prompt must be ${MAX_SYSTEM_PROMPT} characters or fewer`;
            }
            if (config.duration !== null) {
                const minutes = Number(el('durationInput').value);
                if (!Number.isFinite(minutes)
                    || minutes < MIN_DURATION_MINUTES
                    || minutes > MAX_DURATION_MINUTES) {
                    return `Duration must be between ${MIN_DURATION_MINUTES} and ${MAX_DURATION_MINUTES} minutes`;
                }
            }
            return config.validate?.({ participants, fields: fieldValues(), teamNames }) || null;
        }

        function submit() {
            if (busy) {
                const message = 'A launch is already in progress — watch the Games page, or wait for it to finish or fail.';
                logSetup('warn', 'Start ignored: launch already busy');
                setError(message, { scroll: true });
                onStatus(message, true);
                return;
            }
            const alreadyLaunching = getLaunchInProgress();
            if (alreadyLaunching) {
                logSetup('warn', 'Start refused: arena busy', alreadyLaunching);
                setError(alreadyLaunching, { scroll: true });
                onStatus(alreadyLaunching, true);
                return;
            }
            const fields = fieldValues();
            const problem = validate();
            if (problem) {
                logSetup('warn', `Start blocked by validation: ${problem}`, { fields });
                setError(problem, { scroll: true });
                return;
            }
            let request;
            try {
                const submittedTeamNames = config.teams
                    ? teamNames.map(name => name.trim())
                    : null;
                request = config.buildRequest({
                    participants: participants.map(({ profileId, name, voice, systemPrompt, team }) => ({
                        profileId,
                        name,
                        voice: voice || null,
                        systemPrompt: String(systemPrompt || '').trim(),
                        ...(config.teams ? {
                            team: submittedTeamNames[teamNames.indexOf(team)] || String(team || '').trim(),
                        } : {}),
                    })),
                    systemPrompt: String(el('systemPrompt').value || '').trim(),
                    durationMs: Number(el('durationInput').value) * 60_000,
                    fields,
                    teamNames: submittedTeamNames,
                    recordingEnabled: el('recordingEnabled').checked,
                    autoRecordingEnabled: el('autoRecordingEnabled').checked,
                });
            } catch (error) {
                const message = error?.message || 'Could not build the start request';
                logSetup('error', 'buildRequest failed', error);
                setError(message, { scroll: true });
                onStatus(message, true);
                return;
            }
            if (!request?.event) {
                const message = 'Game setup did not produce a start event';
                logSetup('error', message, request);
                setError(message, { scroll: true });
                onStatus(message, true);
                return;
            }
            const started = config;

            setBusy(true);
            setError('');
            el('debug').hidden = true;
            logSetup('info', `Emitting ${request.event}`, {
                gameId: request.payload?.gameId,
                participants: request.payload?.participants?.length,
                fields,
                timeoutMs: START_TIMEOUT_MS + Math.max(0, Number(request.extraTimeoutMs) || 0),
            });
            onStatus('Provisioning temporary contest bots…');
            el('footer').textContent = 'Starting… creating temporary contest bots.';
            // A launch takes minutes, and the page behind reports its progress, so
            // step out of the way instead of freezing the roster on screen. The
            // roster stays in memory in case the launch fails and has to come back.
            hide();

            // Phases the server runs before it answers (a team planning window,
            // for instance) are added on top of the provisioning budget.
            const timeoutMs = START_TIMEOUT_MS + Math.max(0, Number(request.extraTimeoutMs) || 0);
            const launchToken = ++launchId;
            socket.timeout(timeoutMs).emit(request.event, request.payload, (err, result) => {
                if (launchToken !== launchId) {
                    logSetup('info', 'Ignoring stale launch ack', { launchToken, launchId });
                    return;
                }
                if (err) {
                    // Our ack window closing does not stop the launch, and the
                    // page behind us is already streaming the real stage-by-stage
                    // progress. Declaring failure here used to bury the precise
                    // error the server was still about to send. Only a dead
                    // socket means no answer is coming.
                    if (socket.connected) {
                        const waiting = 'Still launching — MindServer has not answered yet. Watch the launch progress; the roster returns if it fails.';
                        logSetup('warn', 'Start ack timed out; socket still connected — waiting on server progress', err);
                        onStatus(waiting);
                        el('footer').textContent = waiting;
                        return;
                    }
                    setBusy(false);
                    const message = 'MindServer did not respond. Copy the debug report for Cursor if one is available.';
                    logSetup('error', 'Start failed: socket disconnected before ack', err);
                    setError(message, { scroll: true });
                    onStatus(message, true);
                    el('footer').textContent = 'Lost contact with MindServer.';
                    reopenAfterFailure();
                    fetchLastReport();
                    return;
                }
                setBusy(false);
                if (!result?.success) {
                    const message = result?.error || 'Failed to start the game';
                    logSetup('error', `Start rejected: ${message}`, {
                        launchRefused: result?.launchRefused,
                        hasReport: Boolean(result?.report),
                    });
                    setError(message, { scroll: true });
                    onStatus(message, true);
                    reopenAfterFailure();
                    // Being refused because something already owns the arena is
                    // not that game's failure: there is nothing to diagnose, and
                    // a report would point at a game that is still fine.
                    if (result?.launchRefused) {
                        el('footer').textContent = 'Nothing failed — the arena is taken. Let it finish or cancel it, then start again.';
                        return;
                    }
                    el('footer').textContent = 'Fix the error and try again.';
                    if (result?.report) showReport(result.report);
                    else fetchLastReport();
                    return;
                }
                logSetup('info', 'Start acknowledged', {
                    contestId: result.data?.contest?.id,
                    sessionId: result.data?.gameSession?.id,
                });
                close();
                started.onStarted?.(result);
            });
        }

        function isVisible() {
            return Boolean(config) && backdrop.style.display !== 'none';
        }

        function hide() {
            backdrop.style.display = 'none';
            if (previewAudio) { previewAudio.pause(); previewAudio = null; }
        }

        function reopenAfterFailure() {
            if (!config) return;
            backdrop.style.display = 'flex';
        }

        function close() {
            hide();
            config = null;
            participants = [];
            teamNames = [];
            setError('');
            setVoiceStatus('');
            el('debug').hidden = true;
        }

        function open(nextConfig) {
            if (busy) return;
            const profiles = configuredProfiles();
            if (!profiles.length) {
                onStatus('No configured model profiles available', true);
                return;
            }
            config = nextConfig;
            selectedLineupId = nextConfig.lineupId || getDefaultBotModelLineupId();
            participants = (nextConfig.participants || []).map(participant => ({ ...participant }));
            teamNames = nextConfig.teams
                ? [...(nextConfig.teams.defaultNames || ['Ember', 'Tide'])].slice(0, 2)
                : [];
            if (nextConfig.teams) {
                participants.forEach((participant, index) => {
                    if (!teamNames.includes(participant.team)) {
                        participant.team = teamNames[index % teamNames.length];
                    }
                });
            }
            el('title').textContent = nextConfig.title || 'Set up game';
            el('footer').textContent = nextConfig.footer || 'Pick profiles and unique Minecraft names, then start.';
            action('submit').textContent = nextConfig.submitLabel || 'Start game';
            el('duration').hidden = nextConfig.duration === null;
            el('durationInput').value = String(nextConfig.duration?.minutes ?? 1);
            el('recordingEnabled').checked = false;
            el('autoRecordingEnabled').checked = false;
            el('systemPrompt').value = '';
            el('promptCount').textContent = '0';
            renderFields();
            renderTeams();
            renderLineup();
            setError('');
            el('debug').hidden = true;
            renderParticipants();
            backdrop.style.display = 'flex';
            loadVoices();
        }

        action('add').addEventListener('click', () => {
            const profiles = configuredProfiles();
            if (!profiles.length) return;
            if (config?.maxParticipants && participants.length >= config.maxParticipants) return;
            const used = new Set(participants.map(participant => participant.profileId));
            const rotation = profilesByFamily(profiles);
            const profile = rotation.find(item => !used.has(item.id)) || rotation[0];
            participants.push({
                profileId: profile.id,
                name: nextUniqueMinecraftName(profile.name || profile.id || 'bot', reservedNames()),
                voice: null,
                systemPrompt: '',
                ...(config?.teams
                    ? { team: teamNames[participants.length % teamNames.length] }
                    : {}),
            });
            renderParticipants();
        });
        action('close').addEventListener('click', () => { if (!busy) close(); });
        action('cancel').addEventListener('click', () => { if (!busy) close(); });
        action('submit').addEventListener('click', submit);
        action('copy-report').addEventListener('click', async event => {
            if (!lastReport) return;
            const button = event.currentTarget;
            const label = button.textContent;
            try {
                await navigator.clipboard.writeText(lastReport);
                button.textContent = 'Copied!';
                setTimeout(() => { button.textContent = label; }, 1500);
            } catch (error) {
                const textarea = el('debugText');
                textarea.focus();
                textarea.select();
                onStatus(`Could not copy automatically: ${error.message}`, true);
            }
        });
        el('lineupSelect').addEventListener('change', event => {
            selectedLineupId = event.target.value;
            applySelectedLineup();
            renderLineup();
            renderParticipants();
        });
        el('systemPrompt').addEventListener('input', event => {
            el('promptCount').textContent = String(event.target.value.length);
        });
        el('recordingEnabled').addEventListener('change', event => {
            if (event.target.checked) el('autoRecordingEnabled').checked = false;
        });
        el('autoRecordingEnabled').addEventListener('change', event => {
            if (event.target.checked) el('recordingEnabled').checked = false;
        });

        return {
            open,
            close,
            // The page can learn a launch died before its ack arrives — a dropped
            // MindServer connection, say — and bring the roster back rather than
            // leaving it locked until the ack timeout expires.
            abortLaunch(message) {
                if (!busy) return;
                launchId++;
                setBusy(false);
                if (message) setError(message);
                reopenAfterFailure();
            },
            isOpen: isVisible,
            isBusy: () => busy,
            setFooter: text => { el('footer').textContent = text; },
            setStatusMessage: setError,
            showReport,
            defaultParticipantsFor,
        };
    };
})();
