(function () {
    const el = id => document.getElementById(id);
    const params = new URLSearchParams(location.search);
    let summaries = [];
    let selectedAgent = params.get('agent');
    let selectedCall = params.get('call');
    let selectedEntry = null;
    let search = '';
    let kindFilter = '';
    let loadingDetail = false;
    const entryCache = new Map();

    function esc(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function timeLabel(value) {
        if (!value) return '—';
        return new Date(value).toLocaleString([], {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
    }

    function durationLabel(ms) {
        if (ms === null || ms === undefined) return 'in progress';
        if (ms < 1000) return `${ms} ms`;
        return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
    }

    function modelLabel(model) {
        return model?.model || model?.provider || 'default model';
    }

    function categoryForAgent(agent) {
        return summaries.find(item => item.agent === agent)?.category || {
            label: agent,
            reviewState: 'unreviewed',
            note: '',
        };
    }

    async function requestJson(url, options = {}) {
        const response = await fetch(url, options);
        const payload = await response.json();
        if (!response.ok || !payload.success) {
            throw new Error(payload.error || `Request failed (${response.status})`);
        }
        return payload;
    }

    function entriesForAgent(agent) {
        const needle = search.trim().toLowerCase();
        return summaries.filter(item => {
            if (item.agent !== agent) return false;
            if (kindFilter && item.kind !== kindFilter) return false;
            if (!needle) return true;
            const detail = entryCache.get(item.id);
            return [
                item.kind,
                modelLabel(item.model),
                item.responsePreview,
                detail?.request?.systemPrompt,
                detail?.context?.memory,
                typeof detail?.request?.embeddingInput === 'string'
                    ? detail.request.embeddingInput
                    : JSON.stringify(detail?.request?.embeddingInput),
                JSON.stringify(detail?.request?.messages || []),
                typeof detail?.response === 'string' ? detail.response : JSON.stringify(detail?.response),
            ].some(value => String(value || '').toLowerCase().includes(needle));
        });
    }

    function agentNames() {
        return [...new Set(summaries.map(item => item.agent))].sort((left, right) => {
            const leftLatest = summaries.find(item => item.agent === left)?.startedAt || '';
            const rightLatest = summaries.find(item => item.agent === right)?.startedAt || '';
            return rightLatest.localeCompare(leftLatest) || left.localeCompare(right);
        });
    }

    function ensureSelection() {
        const names = agentNames();
        if (!selectedAgent || !names.includes(selectedAgent)) selectedAgent = names[0] || null;
        const calls = selectedAgent ? entriesForAgent(selectedAgent) : [];
        if (!selectedCall || !calls.some(item => item.id === selectedCall)) {
            selectedCall = calls[0]?.id || null;
            selectedEntry = selectedCall ? entryCache.get(selectedCall) || null : null;
        }
    }

    function syncUrl() {
        const next = new URLSearchParams();
        if (selectedAgent) next.set('agent', selectedAgent);
        if (selectedCall) next.set('call', selectedCall);
        history.replaceState(null, '', `${location.pathname}${next.size ? `?${next}` : ''}`);
    }

    function renderAgents() {
        const names = agentNames();
        el('agentCount').textContent = names.length ? `${names.length} total` : '';
        el('agents').innerHTML = names.length
            ? names.map(name => {
                const all = summaries.filter(item => item.agent === name);
                const category = categoryForAgent(name);
                const pending = all.filter(item => item.status === 'pending').length;
                const failed = all.filter(item => item.status === 'error').length;
                const state = pending ? `${pending} live` : failed ? `${failed} failed` : `${all.length} captured`;
                return `<button class="row${name === selectedAgent ? ' selected' : ''}" data-agent="${esc(name)}">
                    <span class="row-top">
                        <span class="row-title">${esc(category.label)}</span>
                        <span class="category-state ${esc(category.reviewState)}">${esc(category.reviewState)}</span>
                        <span class="agent-count">${all.length}</span>
                    </span>
                    <span class="meta">${category.label !== name ? `${esc(name)} · ` : ''}${esc(state)} · latest ${esc(timeLabel(all[0]?.startedAt))}</span>
                    ${category.note ? `<span class="preview">${esc(category.note)}</span>` : ''}
                </button>`;
            }).join('')
            : '<div class="empty">No LLM calls captured yet. New calls appear here automatically.</div>';
        el('categoryAction').disabled = !selectedAgent;
    }

    function renderCalls() {
        const calls = selectedAgent ? entriesForAgent(selectedAgent) : [];
        const chronological = [...summaries]
            .filter(item => item.agent === selectedAgent)
            .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
        const numberById = new Map(chronological.map((item, index) => [item.id, index + 1]));
        el('callsTitle').textContent = selectedAgent
            ? categoryForAgent(selectedAgent).label
            : 'Calls';
        el('callCount').textContent = calls.length ? `${calls.length} shown` : '';
        el('calls').innerHTML = calls.length
            ? calls.map(item => `<button class="row${item.id === selectedCall ? ' selected' : ''}" data-call="${esc(item.id)}">
                <span class="row-top">
                    <span class="row-title">#${numberById.get(item.id)} · ${esc(item.kind)}</span>
                    <span class="badge ${esc(item.status)}">${esc(item.status)}</span>
                </span>
                <span class="meta">${esc(timeLabel(item.startedAt))} · ${esc(durationLabel(item.durationMs))} · ${esc(item.callMethod || 'sendRequest')} · ${esc(modelLabel(item.model))}</span>
                <span class="preview">${esc(item.responsePreview || (item.inputCharacters
                    ? `${item.inputCharacters} embedding input chars`
                    : `${item.messageCount} messages · ${item.promptCharacters} prompt chars`))}</span>
            </button>`).join('')
            : `<div class="empty">${search || kindFilter ? 'No calls match these filters.' : 'This agent has no captured calls.'}</div>`;
    }

    function messageHtml(message, index) {
        const role = message?.role || 'unknown';
        const content = typeof message?.content === 'string'
            ? message.content
            : JSON.stringify(message?.content, null, 2);
        return `<div class="message ${esc(role)}">
            <div class="role">${index + 1}. ${esc(role)}</div>
            <div class="content">${esc(content)}</div>
        </div>`;
    }

    function detailSection(title, body, open = false) {
        return `<details${open ? ' open' : ''}><summary>${esc(title)}</summary><div class="section-body">${body}</div></details>`;
    }

    function renderDetail() {
        if (loadingDetail && !selectedEntry) {
            el('detail').innerHTML = '<div class="empty">Loading complete context…</div>';
            return;
        }
        if (!selectedEntry) {
            el('detail').innerHTML = '<div class="empty">Select a call to inspect everything sent to the model.</div>';
            el('detailCount').textContent = '';
            return;
        }
        const entry = selectedEntry;
        const agentCalls = summaries
            .filter(item => item.agent === entry.agent)
            .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
        const callNumber = agentCalls.findIndex(item => item.id === entry.id) + 1;
        const messages = entry.request?.messages || [];
        const response = typeof entry.response === 'string'
            ? entry.response
            : JSON.stringify(entry.response, null, 2);
        const raw = JSON.stringify(entry, null, 2);
        el('detailCount').textContent = entry.callMethod === 'embed'
            ? 'embedding'
            : `${messages.length} messages`;
        el('detail').innerHTML = `<div class="detail">
            <div class="detail-title">
                <div>
                    <div class="eyebrow">${esc(entry.agent)} · call ${callNumber} · ${esc(entry.callMethod || 'sendRequest')}</div>
                    <h2>#${callNumber} ${esc(entry.kind)}</h2>
                    <div class="meta">${esc(entry.id)}</div>
                </div>
                <div class="actions">
                    <button class="button" id="speakButton" type="button">Read aloud</button>
                    <button class="button" id="copyButton" type="button">Copy JSON</button>
                    <button class="button" id="downloadButton" type="button">Download</button>
                    <button class="button danger" id="deleteCallButton" type="button">Delete call</button>
                </div>
            </div>
            <div class="facts">
                <div class="fact"><div class="eyebrow">Model</div><div class="fact-value">${esc(modelLabel(entry.model))}</div></div>
                <div class="fact"><div class="eyebrow">Provider</div><div class="fact-value">${esc(entry.model?.provider || 'unknown')}</div></div>
                <div class="fact"><div class="eyebrow">Started</div><div class="fact-value">${esc(timeLabel(entry.startedAt))}</div></div>
                <div class="fact"><div class="eyebrow">Duration</div><div class="fact-value">${esc(durationLabel(entry.durationMs))}</div></div>
            </div>
            ${entry.error ? detailSection('Error', `<pre class="error-text">${esc(entry.error.stack || entry.error.message)}</pre>`, true) : ''}
            ${entry.request?.embeddingInput !== null && entry.request?.embeddingInput !== undefined
                ? detailSection('Embedding input', `<pre>${esc(typeof entry.request.embeddingInput === 'string' ? entry.request.embeddingInput : JSON.stringify(entry.request.embeddingInput, null, 2))}</pre>`, true)
                : ''}
            ${detailSection(`System prompt · ${(entry.request?.systemPrompt || '').length.toLocaleString()} characters`, `<pre>${esc(entry.request?.systemPrompt || '(empty)')}</pre>`, true)}
            ${detailSection(`Conversation · ${messages.length} messages`, messages.length ? messages.map(messageHtml).join('') : '<div class="empty">No conversation messages were sent.</div>', true)}
            ${detailSection(`Memory snapshot · ${(entry.context?.memory || '').length.toLocaleString()} characters`, `<pre>${esc(entry.context?.memory || '(empty)')}</pre>`)}
            ${entry.request?.image ? detailSection('Vision image', `<img class="image" src="${esc(entry.request.image.url)}" alt="Image sent to the vision model"><div class="meta">${esc(`${entry.request.image.bytes} bytes · ${entry.request.image.mimeType}`)}</div>`) : ''}
            ${detailSection('Model settings', `<pre>${esc(JSON.stringify(entry.model, null, 2))}</pre>`)}
            ${detailSection('Response', `<pre class="response">${esc(response || '(no response)')}</pre>`, true)}
            ${detailSection('Complete audit JSON', `<pre>${esc(raw)}</pre>`)}
        </div>`;

        el('copyButton').addEventListener('click', async () => {
            await navigator.clipboard.writeText(raw);
            el('copyButton').textContent = 'Copied';
        });
        el('downloadButton').addEventListener('click', () => {
            const link = document.createElement('a');
            link.href = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
            link.download = `${entry.agent}_${entry.id}.json`;
            link.click();
            URL.revokeObjectURL(link.href);
        });
        el('speakButton').addEventListener('click', () => {
            speechSynthesis.cancel();
            const text = [
                `${entry.agent}, call ${callNumber}, ${entry.kind}.`,
                'System prompt.',
                entry.request?.systemPrompt || '',
                'Conversation.',
                ...messages.map(message => `${message.role}. ${typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}`),
                'Response.',
                response || 'No response.',
            ].join('\n');
            speechSynthesis.speak(new SpeechSynthesisUtterance(text));
        });
        el('deleteCallButton').addEventListener('click', async () => {
            if (!window.confirm(`Delete call #${callNumber}? This cannot be undone.`)) return;
            try {
                await requestJson(`/api/llm-audit/${encodeURIComponent(entry.agent)}/${encodeURIComponent(entry.id)}`, {
                    method: 'DELETE',
                });
                entryCache.delete(entry.id);
                summaries = summaries.filter(item => item.id !== entry.id);
                selectedCall = null;
                selectedEntry = null;
                render();
                await refresh();
            } catch (error) {
                window.alert(error.message);
            }
        });
    }

    function render() {
        ensureSelection();
        renderAgents();
        renderCalls();
        renderDetail();
        syncUrl();
    }

    async function loadEntry(id) {
        if (!id) {
            selectedEntry = null;
            renderDetail();
            return;
        }
        if (entryCache.has(id)) {
            selectedEntry = entryCache.get(id);
            renderDetail();
            return;
        }
        const summary = summaries.find(item => item.id === id);
        if (!summary) return;
        loadingDetail = true;
        selectedEntry = null;
        renderDetail();
        try {
            const response = await fetch(`/api/llm-audit/${encodeURIComponent(summary.agent)}/${encodeURIComponent(id)}`);
            const payload = await response.json();
            if (!payload.success) throw new Error(payload.error || 'Could not load audit');
            entryCache.set(id, payload.entry);
            if (selectedCall === id) selectedEntry = payload.entry;
        } catch (error) {
            el('detail').innerHTML = `<div class="empty error-text">${esc(error.message)}</div>`;
        } finally {
            loadingDetail = false;
            renderDetail();
        }
    }

    async function hydrateSearch() {
        if (!search.trim()) return;
        const missing = summaries.filter(item => !entryCache.has(item.id));
        await Promise.all(missing.map(async item => {
            try {
                const response = await fetch(`/api/llm-audit/${encodeURIComponent(item.agent)}/${encodeURIComponent(item.id)}`);
                const payload = await response.json();
                if (payload.success) entryCache.set(item.id, payload.entry);
            } catch {
                // A call may be replaced atomically while this request is in flight.
            }
        }));
    }

    async function refresh() {
        try {
            const response = await fetch('/api/llm-audit?limit=5000');
            const payload = await response.json();
            if (!payload.success) throw new Error(payload.error || 'Audit API failed');
            summaries = payload.entries || [];
            const kinds = [...new Set(summaries.map(item => item.kind))].sort();
            const current = el('kindFilter').value;
            el('kindFilter').innerHTML = '<option value="">All calls</option>'
                + kinds.map(kind => `<option value="${esc(kind)}">${esc(kind)}</option>`).join('');
            el('kindFilter').value = current;
            el('status').textContent = 'live · just updated';
            el('status').className = 'status live';
            ensureSelection();
            render();
            await loadEntry(selectedCall);
        } catch (error) {
            el('status').textContent = error.message;
            el('status').className = 'status';
        }
    }

    el('agents').addEventListener('click', event => {
        const row = event.target.closest('[data-agent]');
        if (!row) return;
        selectedAgent = row.dataset.agent;
        selectedCall = entriesForAgent(selectedAgent)[0]?.id || null;
        selectedEntry = selectedCall ? entryCache.get(selectedCall) || null : null;
        render();
        loadEntry(selectedCall).catch(() => {});
    });
    el('calls').addEventListener('click', event => {
        const row = event.target.closest('[data-call]');
        if (!row) return;
        selectedCall = row.dataset.call;
        selectedEntry = entryCache.get(selectedCall) || null;
        render();
        loadEntry(selectedCall).catch(() => {});
    });
    el('kindFilter').addEventListener('change', event => {
        kindFilter = event.target.value;
        selectedCall = null;
        selectedEntry = null;
        render();
        loadEntry(selectedCall).catch(() => {});
    });
    let searchTimer = null;
    el('search').addEventListener('input', event => {
        search = event.target.value;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(async () => {
            await hydrateSearch();
            selectedCall = null;
            selectedEntry = null;
            render();
            await loadEntry(selectedCall);
        }, 180);
    });
    el('categoryAction').addEventListener('change', async event => {
        const action = event.target.value;
        event.target.value = '';
        if (!action || !selectedAgent) return;
        const agent = selectedAgent;
        const category = categoryForAgent(agent);
        try {
            if (action === 'delete') {
                if (!window.confirm(`Delete “${category.label}” and all ${summaries.filter(item => item.agent === agent).length} captured calls? This cannot be undone.`)) return;
                await requestJson(`/api/llm-audit/${encodeURIComponent(agent)}`, { method: 'DELETE' });
                for (const item of summaries.filter(item => item.agent === agent)) entryCache.delete(item.id);
                summaries = summaries.filter(item => item.agent !== agent);
                selectedAgent = null;
                selectedCall = null;
                selectedEntry = null;
                render();
                await refresh();
                return;
            }
            let updates;
            if (action === 'rename') {
                const label = window.prompt('Category label', category.label);
                if (label === null || label.trim() === category.label) return;
                updates = { label };
            } else if (action === 'note') {
                const note = window.prompt('Category note (leave blank to clear)', category.note || '');
                if (note === null) return;
                updates = { note };
            } else {
                updates = { reviewState: action };
            }
            const payload = await requestJson(`/api/llm-audit/${encodeURIComponent(agent)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updates),
            });
            summaries
                .filter(item => item.agent === agent)
                .forEach(item => { item.category = payload.category; });
            render();
        } catch (error) {
            window.alert(error.message);
        }
    });

    refresh().catch(() => {});
    setInterval(() => refresh().catch(() => {}), 2000);
})();
