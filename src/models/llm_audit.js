import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
    existsSync,
    promises as fs,
    readdirSync,
    readFileSync,
    statSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDir, '../..');
const botsRoot = path.join(projectRoot, 'bots');
const auditVersion = 1;
const auditContext = new AsyncLocalStorage();

function safeSegment(value) {
    return String(value || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
}

function cloneForJson(value) {
    if (value === undefined) return null;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return String(value);
    }
}

function modelDetails(model) {
    return {
        provider: model?.constructor?.prefix || model?.constructor?.name || 'unknown',
        model: model?.model_name || null,
        url: model?.url || null,
        params: cloneForJson(model?.params || {}),
    };
}

function auditDirectory(agentName) {
    return path.join(botsRoot, safeSegment(agentName), 'llm-audit');
}

function auditFile(agentName, id) {
    return path.join(auditDirectory(agentName), `${safeSegment(id)}.json`);
}

async function writeEntry(entry) {
    const directory = auditDirectory(entry.agent);
    await fs.mkdir(directory, { recursive: true });
    const destination = auditFile(entry.agent, entry.id);
    const temporary = `${destination}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(entry, null, 2), 'utf8');
    await fs.rename(temporary, destination);
}

export async function beginLLMAudit({
    agent,
    kind,
    model,
    systemPrompt,
    messages,
    memory,
    taskId,
    imageBuffer = null,
    embeddingInput = null,
    callMethod = 'sendRequest',
    parentId = null,
}) {
    const startedAt = new Date().toISOString();
    const id = `${startedAt.replace(/[:.]/g, '-')}_${randomUUID()}`;
    const entry = {
        version: auditVersion,
        id,
        agent: String(agent || 'unknown'),
        kind: String(kind || 'unknown'),
        callMethod,
        parentId,
        status: 'pending',
        startedAt,
        completedAt: null,
        durationMs: null,
        taskId: taskId ?? null,
        model: modelDetails(model),
        context: {
            memory: String(memory || ''),
        },
        request: {
            systemPrompt: String(systemPrompt || ''),
            messages: cloneForJson(messages || []),
            image: null,
            embeddingInput: embeddingInput === null
                ? null
                : cloneForJson(embeddingInput),
        },
        response: null,
        error: null,
    };

    try {
        if (imageBuffer) {
            const directory = auditDirectory(entry.agent);
            await fs.mkdir(directory, { recursive: true });
            const imageName = `${safeSegment(id)}.jpg`;
            await fs.writeFile(path.join(directory, imageName), imageBuffer);
            entry.request.image = {
                mimeType: 'image/jpeg',
                bytes: imageBuffer.length,
                url: `/bots/${encodeURIComponent(safeSegment(entry.agent))}/llm-audit/${encodeURIComponent(imageName)}`,
            };
        }
        await writeEntry(entry);
    } catch (error) {
        console.error('Failed to begin LLM audit entry:', error);
    }
    return entry;
}

export function withLLMAuditContext(context, callback) {
    return auditContext.run({ ...context, parentId: null }, callback);
}

export function setLLMAuditModelDefaults(model, defaults) {
    model.__llmAuditDefaults = { ...(model.__llmAuditDefaults || {}), ...defaults };
    return model;
}

function requestParts(method, args) {
    if (method === 'embed') {
        return {
            messages: [],
            systemPrompt: '',
            imageBuffer: null,
            embeddingInput: args[0],
        };
    }
    return {
        messages: args[0] || [],
        systemPrompt: args[1] || '',
        imageBuffer: method === 'sendVisionRequest' ? args[2] : null,
        embeddingInput: null,
    };
}

function recordedResponse(method, response) {
    if (method !== 'embed') return response;
    const vectors = Array.isArray(response?.embeddings)
        ? response.embeddings
        : response;
    const first = Array.isArray(vectors?.[0]) ? vectors[0] : vectors;
    return {
        dimensions: Array.isArray(first) ? first.length : null,
        outputType: response?.constructor?.name || typeof response,
    };
}

export function instrumentLLMModel(model) {
    if (model.__llmAuditInstrumented) return model;
    Object.defineProperty(model, '__llmAuditInstrumented', {
        value: true,
        enumerable: false,
    });
    for (const method of ['sendRequest', 'sendVisionRequest', 'embed']) {
        if (typeof model[method] !== 'function') continue;
        const original = model[method].bind(model);
        model[method] = async (...args) => {
            const active = auditContext.getStore();
            const defaults = model.__llmAuditDefaults || {};
            const context = { ...defaults, ...(active || {}) };
            const parts = requestParts(method, args);
            const baseKind = context.kind
                || (method === 'embed' ? 'embedding' : method === 'sendVisionRequest' ? 'vision' : 'model-call');
            const kind = method === 'embed' && context.kind
                ? `${context.kind}:embedding`
                : baseKind;
            const audit = await beginLLMAudit({
                ...parts,
                agent: context.agent,
                kind,
                model,
                memory: context.memory,
                taskId: context.taskId,
                callMethod: method,
                parentId: context.parentId || null,
            });
            try {
                const response = await auditContext.run(
                    { ...context, parentId: audit.id },
                    () => original(...args)
                );
                await finishLLMAudit(audit, {
                    response: recordedResponse(method, response),
                });
                return response;
            } catch (error) {
                await finishLLMAudit(audit, { error });
                throw error;
            }
        };
    }
    return model;
}

export async function finishLLMAudit(entry, { response = null, error = null } = {}) {
    const completedAt = new Date();
    entry.completedAt = completedAt.toISOString();
    entry.durationMs = completedAt.getTime() - new Date(entry.startedAt).getTime();
    entry.status = error ? 'error' : 'complete';
    entry.response = response === undefined ? null : cloneForJson(response);
    entry.error = error
        ? {
            name: error.name || 'Error',
            message: error.message || String(error),
            stack: error.stack || null,
        }
        : null;
    try {
        await writeEntry(entry);
    } catch (writeError) {
        console.error('Failed to finish LLM audit entry:', writeError);
    }
    return entry;
}

function validSegment(value) {
    return typeof value === 'string'
        && value.length > 0
        && safeSegment(value) === value;
}

export function readLLMAuditEntry(agentName, id) {
    if (!validSegment(agentName) || !validSegment(id)) return null;
    const filename = auditFile(agentName, id);
    if (!existsSync(filename)) return null;
    try {
        return JSON.parse(readFileSync(filename, 'utf8'));
    } catch (error) {
        console.warn(`Could not read LLM audit entry ${filename}:`, error.message);
        return null;
    }
}

export function listLLMAuditEntries({ agent = null, limit = 1000 } = {}) {
    if (!existsSync(botsRoot)) return [];
    const agentNames = agent && validSegment(agent)
        ? [agent]
        : readdirSync(botsRoot).filter(name => {
            try {
                return statSync(path.join(botsRoot, name)).isDirectory();
            } catch {
                return false;
            }
        });
    const summaries = [];
    for (const agentName of agentNames) {
        const directory = auditDirectory(agentName);
        if (!existsSync(directory)) continue;
        for (const filename of readdirSync(directory)) {
            if (!filename.endsWith('.json')) continue;
            try {
                const entry = JSON.parse(readFileSync(path.join(directory, filename), 'utf8'));
                summaries.push({
                    id: entry.id,
                    agent: entry.agent,
                    kind: entry.kind,
                    callMethod: entry.callMethod,
                    parentId: entry.parentId,
                    status: entry.status,
                    startedAt: entry.startedAt,
                    completedAt: entry.completedAt,
                    durationMs: entry.durationMs,
                    taskId: entry.taskId,
                    model: entry.model,
                    messageCount: entry.request?.messages?.length || 0,
                    promptCharacters: entry.request?.systemPrompt?.length || 0,
                    memoryCharacters: entry.context?.memory?.length || 0,
                    responsePreview: typeof entry.response === 'string'
                        ? entry.response.slice(0, 180)
                        : '',
                    hasImage: Boolean(entry.request?.image),
                    inputCharacters: typeof entry.request?.embeddingInput === 'string'
                        ? entry.request.embeddingInput.length
                        : 0,
                });
            } catch (error) {
                console.warn(`Could not index LLM audit entry ${filename}:`, error.message);
            }
        }
    }
    return summaries
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
        .slice(0, Math.max(1, Math.min(Number(limit) || 1000, 5000)));
}
