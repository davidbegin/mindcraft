import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
    beginLLMAudit,
    deleteLLMAuditCategory,
    deleteLLMAuditEntry,
    finishLLMAudit,
    instrumentLLMModel,
    listLLMAuditEntries,
    readLLMAuditCategory,
    readLLMAuditEntry,
    setLLMAuditModelDefaults,
    updateLLMAuditCategory,
    withLLMAuditContext,
} from '../src/models/llm_audit.js';

class FakeModel {
    constructor() {
        this.model_name = 'test-model';
        this.params = { temperature: 0.25 };
        this.retried = false;
    }

    sendRequest(turns) {
        if (!this.retried && turns.length > 1) {
            this.retried = true;
            return this.sendRequest(turns.slice(1), 'same prompt');
        }
        return 'model response';
    }

    embed(input) {
        return [String(input).length];
    }
}
FakeModel.prefix = 'test-provider';

test('persists complete LLM context and indexes its summary', async () => {
    const agent = `audit-test-${randomUUID()}`;
    const auditDirectory = path.join('bots', agent, 'llm-audit');
    try {
        const entry = await beginLLMAudit({
            agent,
            kind: 'conversation',
            model: new FakeModel(),
            systemPrompt: 'System prompt with rendered memory.',
            messages: [{ role: 'user', content: 'Hello' }],
            memory: 'A complete memory snapshot.',
            taskId: 'task-7',
        });
        await finishLLMAudit(entry, { response: 'Hi there' });

        const stored = readLLMAuditEntry(agent, entry.id);
        assert.equal(stored.status, 'complete');
        assert.equal(stored.request.systemPrompt, 'System prompt with rendered memory.');
        assert.deepEqual(stored.request.messages, [{ role: 'user', content: 'Hello' }]);
        assert.equal(stored.context.memory, 'A complete memory snapshot.');
        assert.equal(stored.response, 'Hi there');
        assert.equal(stored.model.provider, 'test-provider');
        assert.equal(stored.model.model, 'test-model');
        assert.deepEqual(stored.model.params, { temperature: 0.25 });

        const summary = listLLMAuditEntries({ agent }).find(item => item.id === entry.id);
        assert.ok(summary);
        assert.equal(summary.messageCount, 1);
        assert.equal(summary.memoryCharacters, 27);
        assert.equal(summary.responsePreview, 'Hi there');
    } finally {
        await fs.rm(path.join('bots', agent), { recursive: true, force: true });
    }
});

test('records failed calls without losing their request', async () => {
    const agent = `audit-test-${randomUUID()}`;
    try {
        const entry = await beginLLMAudit({
            agent,
            kind: 'coding',
            model: new FakeModel(),
            systemPrompt: 'Write code.',
            messages: [],
            memory: '',
        });
        await finishLLMAudit(entry, { error: new Error('provider unavailable') });

        const stored = readLLMAuditEntry(agent, entry.id);
        assert.equal(stored.status, 'error');
        assert.equal(stored.error.message, 'provider unavailable');
        assert.equal(stored.request.systemPrompt, 'Write code.');
    } finally {
        await fs.rm(path.join('bots', agent), { recursive: true, force: true });
    }
});

test('labels, reviews, and deletes audit categories and calls', async () => {
    const agent = `audit-test-${randomUUID()}`;
    try {
        const first = await beginLLMAudit({ agent, kind: 'conversation' });
        const second = await beginLLMAudit({ agent, kind: 'conversation' });
        await finishLLMAudit(first, { response: 'first' });
        await finishLLMAudit(second, { response: 'second' });

        assert.deepEqual(readLLMAuditCategory(agent), {
            label: agent,
            reviewState: 'unreviewed',
            note: '',
        });
        const category = await updateLLMAuditCategory(agent, {
            label: 'Needs investigation',
            reviewState: 'pending',
            note: 'Unexpected background traffic',
        });
        assert.deepEqual(category, {
            label: 'Needs investigation',
            reviewState: 'pending',
            note: 'Unexpected background traffic',
        });
        assert.deepEqual(listLLMAuditEntries({ agent })[0].category, category);

        assert.equal(await deleteLLMAuditEntry(agent, first.id), true);
        assert.equal(readLLMAuditEntry(agent, first.id), null);
        assert.equal(listLLMAuditEntries({ agent }).length, 1);

        assert.equal(await deleteLLMAuditCategory(agent), true);
        assert.deepEqual(listLLMAuditEntries({ agent }), []);
        assert.equal(await deleteLLMAuditCategory(agent), false);
    } finally {
        await fs.rm(path.join('bots', agent), { recursive: true, force: true });
    }
});

test('model instrumentation captures adapter retries and embeddings', async () => {
    const agent = `audit-test-${randomUUID()}`;
    try {
        const model = instrumentLLMModel(new FakeModel());
        setLLMAuditModelDefaults(model, { agent });
        const response = await withLLMAuditContext({
            agent,
            kind: 'conversation',
            memory: 'remember this',
            taskId: 'task-9',
        }, () => model.sendRequest([
            { role: 'user', content: 'first' },
            { role: 'user', content: 'second' },
        ], 'system prompt'));
        assert.equal(response, 'model response');
        assert.deepEqual(await model.embed('embedding text'), [14]);

        const summaries = listLLMAuditEntries({ agent });
        const calls = summaries.filter(item => item.callMethod === 'sendRequest');
        const embeddings = summaries.filter(item => item.callMethod === 'embed');
        assert.equal(calls.length, 2);
        assert.equal(embeddings.length, 1);

        const child = calls.find(item => item.parentId);
        assert.ok(child);
        const childEntry = readLLMAuditEntry(agent, child.id);
        assert.equal(childEntry.request.messages.length, 1);
        assert.equal(childEntry.context.memory, 'remember this');

        const embedding = readLLMAuditEntry(agent, embeddings[0].id);
        assert.equal(embedding.kind, 'embedding');
        assert.equal(embedding.request.embeddingInput, 'embedding text');
    } finally {
        await fs.rm(path.join('bots', agent), { recursive: true, force: true });
    }
});
