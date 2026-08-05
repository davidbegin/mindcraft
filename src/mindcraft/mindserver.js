import { Server } from 'socket.io';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import * as mindcraft from './mindcraft.js';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, mkdtempSync, copyFileSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import { hasKey } from '../utils/keys.js';
import {
    VOICE_POOL, VOICE_DESCRIPTIONS, DEFAULT_ELEVENLABS_MODEL,
    getVoicesConfig, saveVoicesConfig, autoVoiceName, resolveVoice,
} from '../agent/tts_voices.js';
import { TTSConfig as elevenLabsTTSConfig } from '../models/elevenlabs.js';
import { ColonyCoordinator } from './colony/colony_coordinator.js';
import { getGpt56Profiles } from './model_profiles.js';
import { ensureSkin, SKINS_DIR } from './skins.js';
import { assignModelTeam } from './nametags.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mindserver is:
// - central hub for communication between all agent processes
// - api to control from other languages and remote users 
// - host for webapp

let io;
let server;
const agent_connections = {};
const agent_listeners = [];
let colonyCoordinator = null;
let colonyReady = null;
let colonySupervisorInterval = null;
let colonySettings = null;

// Circuit breaker for non-retryable model provider failures (exhausted credits, revoked
// keys). While it is open the colony stays paused and a single agent probes the provider on
// an exponential backoff instead of every agent retrying on every self-prompt.
const idleModelOutage = Object.freeze({
    active: false,
    reason: null,
    code: null,
    since: null,
    attempts: 0,
    nextProbeAt: 0,
});
let modelOutage = { ...idleModelOutage };

const settings_spec = JSON.parse(readFileSync(path.join(__dirname, 'public/settings_spec.json'), 'utf8'));
const projectRoot = path.resolve(__dirname, '../..');
const providerKeys = {
    anthropic: 'ANTHROPIC_API_KEY',
    azure: 'AZURE_OPENAI_API_KEY',
    cerebras: 'CEREBRAS_API_KEY',
    cursor: 'CURSOR_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    glhf: 'GHLF_API_KEY',
    google: 'GEMINI_API_KEY',
    groq: 'GROQCLOUD_API_KEY',
    huggingface: 'HUGGINGFACE_API_KEY',
    hyperbolic: 'HYPERBOLIC_API_KEY',
    mercury: 'MERCURY_API_KEY',
    mistral: 'MISTRAL_API_KEY',
    novita: 'NOVITA_API_KEY',
    openai: 'OPENAI_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    qwen: 'QWEN_API_KEY',
    replicate: 'REPLICATE_API_KEY',
    xai: 'XAI_API_KEY',
};

function getProfileProvider(profile) {
    if (typeof profile.model === 'object' && profile.model?.api) {
        return profile.model.api.toLowerCase();
    }

    const model = typeof profile.model === 'string'
        ? profile.model.toLowerCase()
        : profile.model?.model?.toLowerCase() || '';
    const explicitProvider = model.includes('/') ? model.split('/')[0] : null;
    if (explicitProvider && (providerKeys[explicitProvider] || ['ollama', 'vllm', 'lmstudio'].includes(explicitProvider))) {
        return explicitProvider;
    }
    if (model.startsWith('gpt-') || /^o[1-9]/.test(model)) return 'openai';
    if (model.startsWith('claude')) return 'anthropic';
    if (model.startsWith('gemini')) return 'google';
    if (model.startsWith('grok')) return 'xai';
    if (model.startsWith('deepseek')) return 'deepseek';
    if (model.startsWith('qwen')) return 'qwen';
    if (model.startsWith('mercury')) return 'mercury';
    if (model.startsWith('mistral')) return 'mistral';
    if (model.startsWith('composer')) return 'cursor';
    return explicitProvider || 'unknown';
}

function isProviderConfigured(provider) {
    if (['ollama', 'vllm', 'lmstudio'].includes(provider)) {
        return false;
    }
    const key = providerKeys[provider];
    return key ? Boolean(hasKey(key)) : false;
}

function getAvailableProfiles() {
    const profilePaths = [
        path.join(projectRoot, 'andy.json'),
        ...readdirSync(path.join(projectRoot, 'profiles'), { withFileTypes: true })
            .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
            .map(entry => path.join(projectRoot, 'profiles', entry.name)),
    ];

    const generatedProfiles = getGpt56Profiles().map(profile => ({
        ...profile,
        configured: isProviderConfigured(profile.provider),
    }));
    const fileProfiles = profilePaths.flatMap(profilePath => {
        try {
            const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
            if (!profile.name) {
                return [];
            }
            const model = typeof profile.model === 'string'
                ? profile.model
                : profile.model?.model || profile.model?.api || 'default model';
            const provider = getProfileProvider(profile);
            return [{
                id: path.basename(profilePath, '.json'),
                name: profile.name,
                model,
                provider,
                configured: isProviderConfigured(provider),
                profile,
            }];
        } catch (error) {
            console.warn(`Skipping invalid profile ${profilePath}: ${error.message}`);
            return [];
        }
    }).filter(profile => profile.configured);

    fileProfiles.sort((a, b) => {
        if (a.configured !== b.configured) return a.configured ? -1 : 1;
        if (a.provider !== b.provider) {
            if (a.provider === 'cursor') return -1;
            if (b.provider === 'cursor') return 1;
        }
        return a.name.localeCompare(b.name);
    });

    return [
        ...generatedProfiles.filter(profile => profile.configured),
        ...fileProfiles,
    ];
}

function getColonyRoot(options) {
    return path.resolve(projectRoot, options.state_dir || './colony');
}

async function ensureColony(options) {
    if (!options?.enabled) return null;
    colonySettings = { ...options };
    if (!colonyReady) {
        const root = getColonyRoot(options);
        const coordinatorOptions = {
            root,
            leaseMs: options.task_lease_ms ?? 300000,
            spawnCooldownMs: options.spawn_cooldown_ms ?? 120000,
        };
        colonyReady = (existsSync(path.join(root, 'state.json'))
            ? ColonyCoordinator.load(coordinatorOptions)
            : ColonyCoordinator.create(coordinatorOptions)
        ).then(coordinator => {
            colonyCoordinator = coordinator;
            startColonySupervisor();
            return coordinator;
        });
    }
    return colonyReady;
}

function emitColonyUpdate(socket = io) {
    if (colonyCoordinator && socket) {
        socket.emit('colony-update', colonyCoordinator.view());
    }
}

function agentRole(settings) {
    return settings.profile?.colony_role || 'generalist';
}

function currentAgentTask(agentName) {
    return colonyCoordinator.currentTaskFor(agentName);
}

function formatColonyStatus(agentName) {
    const directive = colonyCoordinator.directiveFor(agentName);
    const assigned = directive.claimedTasks[0];
    const available = directive.availableTasks.slice(0, 5)
        .map(task => `${task.id} [${task.role || 'any'}]: ${task.title}`)
        .join('\n');
    return [
        `COLONY PHASE: ${directive.phaseTitle}`,
        `OBJECTIVE: ${directive.objective}`,
        `YOUR ROLE: ${directive.agent.role}`,
        `YOUR TASK: ${assigned ? `${assigned.id}: ${assigned.title}` : 'none claimed'}`,
        `NEXT ACTION: ${directive.instruction}`,
        `AVAILABLE:\n${available || 'No open tasks; propose the next useful task.'}`,
    ].join('\n');
}

async function handleColonyCommand(agentName, command) {
    if (!colonyCoordinator) {
        throw new Error('Colony coordinator is not enabled');
    }
    const { type, payload = {} } = command || {};
    let data;
    switch (type) {
        case 'status':
            return { success: true, message: formatColonyStatus(agentName) };
        case 'task':
            data = currentAgentTask(agentName);
            return {
                success: true,
                data,
                message: data
                    ? `Current task ${data.id}: ${data.title}\n${data.description}`
                    : 'No task claimed. Use !claimColonyTask.',
            };
        case 'claim-task':
            data = await colonyCoordinator.claimNextTask(agentName);
            break;
        case 'complete-task': {
            const task = currentAgentTask(agentName);
            if (!task) throw new Error('No current task to complete');
            data = await colonyCoordinator.completeTask(task.id, agentName, payload.summary);
            break;
        }
        case 'fail-task': {
            const task = currentAgentTask(agentName);
            if (!task) throw new Error('No current task to release');
            data = await colonyCoordinator.failTask(task.id, agentName, payload.reason);
            break;
        }
        case 'propose-task': {
            const agent = colonyCoordinator.snapshot().agents[agentName];
            data = await colonyCoordinator.proposeTask({
                title: payload.title,
                description: payload.details,
                role: agent.role,
                priority: 50,
            });
            break;
        }
        case 'record-progress':
            data = await colonyCoordinator.recordProgress(agentName, payload.summary);
            break;
        case 'publish-artifact':
            data = {
                path: await colonyCoordinator.writeArtifact(payload.path, payload.content),
            };
            break;
        case 'request-agent':
            // Roster changes are manual from the Mindcraft UI. Agents may not
            // auto-replace stopped/removed bots by requesting new specialists.
            data = {
                accepted: false,
                reason: 'manual-roster',
                message: 'Agent roster is managed from the Mindcraft UI. Removing an agent does not spawn a replacement.',
            };
            break;
        case 'model-outage':
            data = await openModelOutage(agentName, payload);
            break;
        default:
            throw new Error(`Unknown colony command: ${type}`);
    }
    emitColonyUpdate();
    return {
        success: true,
        data,
        message: `Colony ${type} succeeded: ${JSON.stringify(data)}`,
    };
}

function firstAgentSettings() {
    return Object.values(agent_connections)[0]?.settings ?? null;
}

async function createColonyAgent(name, role, storedProfile = null) {
    const template = firstAgentSettings();
    if (!template) throw new Error('No agent settings are available as a spawn template');
    const settings = structuredClone(template);
    settings.profile = structuredClone(storedProfile || template.profile);
    settings.profile.name = name;
    settings.profile.colony_role = role;
    settings.load_memory = true;
    settings.init_message = `You are the colony ${role}. Stay well-rounded: always keep and upgrade a sword, shield, armor, food, and tools—role specialty never means skipping combat gear. Read !colonyStatus, claim suitable work, coordinate, and progress continuously.`;
    const result = await mindcraft.createAgent(settings);
    if (!result.success) throw new Error(result.error || `Failed to create ${name}`);
    return name;
}

async function restoreDesiredAgents() {
    const snapshot = colonyCoordinator.snapshot();
    if (snapshot.paused) return;
    const agents = snapshot.agents;
    for (const agent of Object.values(agents)) {
        const latest = colonyCoordinator.snapshot();
        if (latest.paused || !latest.agents[agent.id]?.desired ||
            agent_connections[agent.id] || !agent.profile) continue;
        try {
            await createColonyAgent(agent.id, agent.role, agent.profile);
        } catch (error) {
            console.error(`Failed to restore colony agent ${agent.id}:`, error);
        }
    }
}

function requestFullState(connection) {
    return new Promise((resolve) => {
        if (!connection?.socket) {
            resolve(null);
            return;
        }
        const timeout = setTimeout(() => resolve(null), 5000);
        connection.socket.emit('get-full-state', state => {
            clearTimeout(timeout);
            resolve(state);
        });
    });
}

function sendColonyDirective(agentName, connection) {
    if (!connection.socket) return;
    const directive = colonyCoordinator.directiveFor(agentName);
    connection.last_directive_at = Date.now();
    connection.socket.emit('colony-directive', directive, result => {
        if (!result?.success) {
            console.warn(`Colony directive was rejected by ${agentName}: ${result?.error}`);
            return;
        }
        if (result.status && result.status !== 'started') {
            console.log(`Colony directive for ${agentName}: ${result.status}${result.detail ? ` (${result.detail})` : ''}`);
        }
    });
}

function broadcastColonyDirectives() {
    for (const [agentName, connection] of Object.entries(agent_connections)) {
        if (connection.socket && colonyCoordinator.snapshot().agents[agentName]) {
            sendColonyDirective(agentName, connection);
        }
    }
}

function modelProbeBaseMs() {
    return colonySettings?.model_probe_base_ms ?? 60000;
}

function modelProbeMaxMs() {
    return colonySettings?.model_probe_max_ms ?? 900000;
}

/** Opens the breaker: pauses the colony and tells every agent to stand down. */
async function openModelOutage(reportedBy, payload = {}) {
    const reason = payload.message || 'The model provider rejected requests';
    if (modelOutage.active) {
        return { alreadyOpen: true, reason: modelOutage.reason };
    }
    modelOutage = {
        active: true,
        reason,
        code: payload.code ?? null,
        since: Date.now(),
        attempts: 0,
        nextProbeAt: Date.now() + modelProbeBaseMs(),
    };
    const label = payload.kind === 'auth'
        ? 'Model credentials rejected'
        : 'Model provider quota exhausted';
    console.error(`${label} (reported by ${reportedBy}): ${reason}`);
    console.error(`Colony paused. Probing the provider again in ${Math.round(modelProbeBaseMs() / 1000)}s.`);
    await colonyCoordinator.pause(`${label}: ${reason}`);
    broadcastColonyDirectives();
    emitColonyUpdate();
    return { paused: true, reason };
}

function closeModelOutage() {
    modelOutage = { ...idleModelOutage };
}

function requestModelProbe(connection) {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(false), 30000);
        connection.socket.emit('model-probe', result => {
            clearTimeout(timeout);
            resolve(Boolean(result?.ok));
        });
    });
}

/**
 * Half-open state: asks one live agent to spend a single cheap request testing the provider.
 * Success resumes the colony; failure backs off exponentially up to the configured ceiling.
 */
async function runModelOutageProbe() {
    const now = Date.now();
    if (!modelOutage.active || now < modelOutage.nextProbeAt) return;

    const connection = Object.values(agent_connections)
        .find(candidate => candidate.socket && candidate.in_game);
    if (!connection) {
        modelOutage.nextProbeAt = now + modelProbeBaseMs();
        return;
    }

    modelOutage.attempts += 1;
    const recovered = await requestModelProbe(connection);
    if (recovered) {
        const downFor = Math.round((Date.now() - modelOutage.since) / 1000);
        console.log(`Model provider recovered after ${downFor}s; resuming the colony.`);
        closeModelOutage();
        await colonyCoordinator.resume();
        broadcastColonyDirectives();
        return;
    }

    const backoff = Math.min(
        modelProbeBaseMs() * 2 ** (modelOutage.attempts - 1),
        modelProbeMaxMs()
    );
    modelOutage.nextProbeAt = Date.now() + backoff;
    console.warn(`Model provider still unavailable (attempt ${modelOutage.attempts}); retrying in ${Math.round(backoff / 1000)}s.`);
}

let colonySupervisorRunning = false;
async function runColonySupervisor() {
    if (!colonyCoordinator || colonySupervisorRunning) return;
    colonySupervisorRunning = true;
    try {
        await colonyCoordinator.expireLeases();
        const now = Date.now();
        let state = colonyCoordinator.snapshot();

        for (const agent of Object.values(state.agents)) {
            if (!agent_connections[agent.id] && agent.status !== 'offline') {
                await colonyCoordinator.updateAgent(agent.id, { status: 'offline' });
            }
        }

        // Runs while paused so an open breaker can close itself without manual help.
        if (modelOutage.active) {
            await runModelOutageProbe();
        }

        state = colonyCoordinator.snapshot();
        if (state.paused) {
            emitColonyUpdate();
            return;
        }

        await restoreDesiredAgents();
        state = colonyCoordinator.snapshot();

        // Reject leftover auto-spawn requests instead of creating replacements.
        // New agents are added only via the Mindcraft UI create-agent flow.
        for (const request of state.spawn.requests.filter(item => item.status === 'pending')) {
            await colonyCoordinator.resolveSpawnRequest(request.id, 'rejected');
            console.log(`Rejected pending colony spawn request ${request.id} (${request.role}): manual roster`);
        }

        for (const [agentName, connection] of Object.entries(agent_connections)) {
            const colonyAgent = colonyCoordinator.snapshot().agents[agentName];
            if (!colonyAgent) continue;
            if (connection.in_game && connection.socket) {
                const fullState = await requestFullState(connection);
                const phase = fullState?.action?.phase
                    || (fullState?.action?.isIdle ? 'idle' : 'busy');
                const status = phase === 'idle' ? 'idle' : 'busy';
                await colonyCoordinator.heartbeat(agentName, status);
                const latestState = colonyCoordinator.snapshot();
                // Only nudge when the bot is truly available. Physically idle bots that are
                // already thinking or self-prompting look "Idle" in old UI but are busy.
                const available = fullState?.action?.available === true
                    || (fullState?.action?.available == null
                        && fullState?.action?.isIdle
                        && !fullState?.selfPrompt?.active
                        && !fullState?.action?.thinking);
                if (!latestState.paused && latestState.agents[agentName]?.desired &&
                    available &&
                    now - connection.last_directive_at >=
                    (colonySettings.idle_directive_ms ?? 15000)) {
                    sendColonyDirective(agentName, connection);
                }
            } else {
                const latestState = colonyCoordinator.snapshot();
                const latestAgent = latestState.agents[agentName];
                const process = mindcraft.getAgentProcess(agentName);
                if (!latestState.paused && latestAgent?.desired &&
                    process && !process.running &&
                    now - connection.last_restart_attempt_at >= 30000) {
                    connection.last_restart_attempt_at = now;
                    mindcraft.startAgent(agentName);
                }
            }
        }

        // Do not auto-request replacement agents. Stopping/removing a bot in the
        // UI must leave the roster smaller until a human creates another agent.
        emitColonyUpdate();
    } catch (error) {
        console.error('Colony supervisor pass failed:', error);
    } finally {
        colonySupervisorRunning = false;
    }
}

function startColonySupervisor() {
    if (colonySupervisorInterval) return;
    const interval = colonySettings.heartbeat_interval_ms ?? 10000;
    colonySupervisorInterval = setInterval(runColonySupervisor, interval);
    setTimeout(runColonySupervisor, 1000);
}

class AgentConnection {
    constructor(settings, viewer_port) {
        this.socket = null;
        this.settings = settings;
        this.in_game = false;
        this.full_state = null;
        this.viewer_port = viewer_port;
        this.last_directive_at = 0;
        this.last_restart_attempt_at = 0;
        this.recording = null; // POV recording status reported by the agent process
    }
    setSettings(settings) {
        this.settings = settings;
    }
}

export async function registerAgent(settings, viewer_port) {
    // Every bot gets a generated skin keyed to its name + model so it is
    // visually unique in-game. Hand-authored profile skins are left alone.
    try {
        if (!settings.profile.skin || settings.profile.skin.generated) {
            settings.profile.skin = ensureSkin(settings.profile.name, settings.profile.model);
        }
    } catch (error) {
        console.error(`Failed to generate skin for ${settings.profile.name}:`, error);
    }
    let agentConnection = new AgentConnection(settings, viewer_port);
    const coordinator = await ensureColony(settings.colony);
    let registeredColonyAgent = null;
    if (coordinator) {
        registeredColonyAgent = await coordinator.registerAgent(
            settings.profile.name,
            agentRole(settings),
            'spawning',
            { desired: true, profile: settings.profile }
        );
    }
    agent_connections[settings.profile.name] = agentConnection;
    emitColonyUpdate();
    return registeredColonyAgent;
}

export async function unregisterAgent(agentName, status = 'failed') {
    delete agent_connections[agentName];
    if (colonyCoordinator?.snapshot().agents[agentName]) {
        await colonyCoordinator.updateAgent(agentName, {
            desired: false,
            status,
        });
        emitColonyUpdate();
    }
}

export function logoutAgent(agentName) {
    if (agent_connections[agentName]) {
        agent_connections[agentName].in_game = false;
        agent_connections[agentName].recording = null;
        agentsStatusUpdate();
    }
}

// Forward a recording start/stop request from the UI to the agent's process and relay the ack.
function forwardRecordingCommand(agentName, event, options, callback) {
    const conn = agent_connections[agentName];
    if (!conn?.socket) {
        callback?.({ success: false, error: `Agent '${agentName}' is not connected` });
        return;
    }
    const args = options === undefined ? [] : [options];
    conn.socket.timeout(20000).emit(event, ...args, (err, result) => {
        if (err) {
            callback?.({ success: false, error: `Recording command timed out for ${agentName}` });
            return;
        }
        if (result && typeof result === 'object' && 'recording' in result) {
            conn.recording = result;
        }
        agentsStatusUpdate();
        callback?.(result);
    });
}

// Scan bots/*/recordings for saved MP4s so the UI can list and link them.
function listRecordings() {
    const botsDir = path.join(projectRoot, 'bots');
    try {
        const agents = [];
        if (existsSync(botsDir)) {
            for (const entry of readdirSync(botsDir, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue;
                const recDir = path.join(botsDir, entry.name, 'recordings');
                if (!existsSync(recDir)) continue;
                const files = readdirSync(recDir)
                    .filter(f => f.endsWith('.mp4'))
                    .map(f => {
                        const stats = statSync(path.join(recDir, f));
                        return {
                            file: f,
                            url: `/bots/${encodeURIComponent(entry.name)}/recordings/${encodeURIComponent(f)}`,
                            size: stats.size,
                            mtime: stats.mtimeMs,
                        };
                    })
                    .sort((a, b) => b.mtime - a.mtime);
                if (files.length) {
                    agents.push({ agent: entry.name, folder: recDir, files });
                }
            }
        }
        return { success: true, botsFolder: botsDir, agents };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Everything the Voices modal needs: the editable config, the voice pool,
// and every known bot (connected agents + bots already pinned in voices.json).
function voicesOverview() {
    const config = getVoicesConfig();
    const botNames = new Set([
        ...Object.keys(agent_connections),
        ...Object.keys(config.bots),
    ]);
    return {
        success: true,
        config,
        defaultModel: DEFAULT_ELEVENLABS_MODEL,
        pool: Object.keys(VOICE_POOL).map(name => ({
            name,
            id: VOICE_POOL[name],
            description: VOICE_DESCRIPTIONS[name] || '',
        })),
        bots: [...botNames].sort().map(name => ({
            name,
            connected: Boolean(agent_connections[name]),
            assigned: config.bots[name] || null,
            autoVoice: autoVoiceName(name),
        })),
        previewAvailable: Boolean(hasKey('ELEVENLABS_API_KEY')),
    };
}

// —— Recording export (zip download / folder copy) ——

function parseExportWindow(query) {
    const since = Number(query.since);
    if (!Number.isFinite(since)) return null;
    const until = query.until ? Number(query.until) : Infinity;
    return { since, until: Number.isFinite(until) ? until : Infinity };
}

/**
 * Finished clips whose file was completed inside [since, until] (mtime is
 * when ffmpeg closed the file). Clips still being recorded are excluded —
 * they are not playable until stopped.
 */
function collectRecordingsForExport(since, until) {
    const liveFiles = new Set(Object.values(agent_connections)
        .filter(conn => conn.recording?.recording && conn.recording?.file)
        .map(conn => conn.recording.file));
    const listing = listRecordings();
    if (!listing.success) return { error: listing.error, files: [] };
    const files = [];
    for (const group of listing.agents) {
        for (const f of group.files) {
            const fullPath = path.join(group.folder, f.file);
            if (liveFiles.has(fullPath)) continue;
            if (f.mtime >= since && f.mtime <= until) {
                files.push({ bot: group.agent, name: f.file, path: fullPath, size: f.size, mtime: f.mtime });
            }
        }
    }
    files.sort((a, b) => a.mtime - b.mtime);
    return { files };
}

// The matching slice of the shared manifest goes into every export so the
// exact start/end timestamps and action labels travel with the clips.
function manifestSliceForExport(since, until) {
    const manifestPath = path.join(projectRoot, 'bots', 'recordings-manifest.jsonl');
    if (!existsSync(manifestPath)) return '';
    const lines = readFileSync(manifestPath, 'utf8').split('\n').filter(line => {
        if (!line.trim()) return false;
        try {
            const entry = JSON.parse(line);
            return entry.endedAt >= since && entry.startedAt <= until;
        } catch (_) {
            return false;
        }
    });
    return lines.length ? lines.join('\n') + '\n' : '';
}

function exportStamp(since, until) {
    const fmt = (ms) => new Date(ms).toISOString().replace(/[:]/g, '-').slice(0, 16);
    return until === Infinity ? `${fmt(since)}_onward` : `${fmt(since)}_to_${fmt(until)}`;
}

// Initialize the server
export function createMindServer(host_public = false, port = 8080) {
    const app = express();
    server = http.createServer(app);
    io = new Server(server);

    // Serve static files
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    app.use(express.static(path.join(__dirname, 'public')));
    // Serve bot data (POV recordings, screenshots) so the UI can play/download them
    app.use('/bots', express.static(path.join(projectRoot, 'bots')));
    // Generated bot skins (same /skins path the MC container sees them under)
    app.use('/skins', express.static(SKINS_DIR));

    // What an export window would contain, so the UI can preview before downloading.
    app.get('/api/recordings/export-info', (req, res) => {
        const window = parseExportWindow(req.query);
        if (!window) return res.status(400).json({ success: false, error: 'since (epoch ms) is required' });
        const { files, error } = collectRecordingsForExport(window.since, window.until);
        if (error) return res.status(500).json({ success: false, error });
        res.json({
            success: true,
            count: files.length,
            bytes: files.reduce((sum, f) => sum + f.size, 0),
            bots: [...new Set(files.map(f => f.bot))],
        });
    });

    // Stream every finished clip in the window as one flat zip (+ manifest slice).
    app.get('/api/recordings/export.zip', (req, res) => {
        const window = parseExportWindow(req.query);
        if (!window) return res.status(400).json({ success: false, error: 'since (epoch ms) is required' });
        const { files, error } = collectRecordingsForExport(window.since, window.until);
        if (error) return res.status(500).json({ success: false, error });
        if (!files.length) return res.status(404).json({ success: false, error: 'No finished clips in that time range' });

        // zip needs the manifest slice as a real file to include it in the archive
        const tmpDir = mkdtempSync(path.join(tmpdir(), 'rec-export-'));
        const manifestTmp = path.join(tmpDir, 'manifest.jsonl');
        writeFileSync(manifestTmp, manifestSliceForExport(window.since, window.until));

        const stamp = exportStamp(window.since, window.until);
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="recordings_${stamp}.zip"`);

        // -j flattens paths; clip filenames are unique (bot + timestamp + labels)
        const zip = spawn('zip', ['-q', '-j', '-', manifestTmp, ...files.map(f => f.path)]);
        zip.stdout.pipe(res);
        zip.stderr.on('data', (d) => console.error('zip:', d.toString().trim()));
        zip.on('error', (err) => {
            console.error('Recording export zip failed:', err.message);
            if (!res.headersSent) res.status(500).json({ success: false, error: `zip failed: ${err.message}` });
            else res.end();
        });
        zip.on('close', () => {
            rmSync(tmpDir, { recursive: true, force: true });
        });
        res.on('close', () => {
            if (zip.exitCode === null) zip.kill('SIGKILL');
        });
    });

    // Copy every finished clip in the window (+ manifest slice) into a folder on disk.
    app.get('/api/recordings/export-folder', (req, res) => {
        const window = parseExportWindow(req.query);
        if (!window) return res.status(400).json({ success: false, error: 'since (epoch ms) is required' });
        const { files, error } = collectRecordingsForExport(window.since, window.until);
        if (error) return res.status(500).json({ success: false, error });
        if (!files.length) return res.status(404).json({ success: false, error: 'No finished clips in that time range' });
        try {
            const folder = path.join(projectRoot, 'bots', 'exports', `recordings_${exportStamp(window.since, window.until)}`);
            mkdirSync(folder, { recursive: true });
            for (const f of files) {
                copyFileSync(f.path, path.join(folder, f.name));
            }
            writeFileSync(path.join(folder, 'manifest.jsonl'), manifestSliceForExport(window.since, window.until));
            res.json({
                success: true,
                folder,
                count: files.length,
                bytes: files.reduce((sum, f) => sum + f.size, 0),
            });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // Socket.io connection handling
    io.on('connection', (socket) => {
        let curAgentName = null;
        console.log('Client connected');

        agentsStatusUpdate(socket);

        socket.on('list-profiles', (callback) => {
            callback({ success: true, profiles: getAvailableProfiles() });
        });

        socket.on('colony-status', async (callback) => {
            try {
                if (colonyReady) await colonyReady;
                callback({
                    success: Boolean(colonyCoordinator),
                    data: colonyCoordinator?.view() ?? null,
                    error: colonyCoordinator ? null : 'Colony coordinator is not enabled',
                });
            } catch (error) {
                callback({ success: false, error: error.message });
            }
        });

        socket.on('colony-control', async (action, callback) => {
            try {
                if (colonyReady) await colonyReady;
                if (!colonyCoordinator) throw new Error('Colony coordinator is not enabled');
                if (action === 'pause') {
                    // A manual pause takes over from the breaker so probes stop auto-resuming.
                    closeModelOutage();
                    await colonyCoordinator.pause('Paused from the Mindcraft UI');
                } else if (action === 'resume') {
                    // Resuming by hand retires the breaker; it re-trips if the provider is still down.
                    closeModelOutage();
                    await colonyCoordinator.resume();
                    await runColonySupervisor();
                } else {
                    throw new Error(`Unknown colony control: ${action}`);
                }
                for (const [agentName, connection] of Object.entries(agent_connections)) {
                    if (connection.socket) sendColonyDirective(agentName, connection);
                }
                emitColonyUpdate();
                callback({ success: true, data: colonyCoordinator.view() });
            } catch (error) {
                callback({ success: false, error: error.message });
            }
        });

        socket.on('colony-command', async (command, callback) => {
            try {
                if (!curAgentName) throw new Error('Only a registered agent can issue colony commands');
                if (colonyReady) await colonyReady;
                callback(await handleColonyCommand(curAgentName, command));
            } catch (error) {
                callback({ success: false, error: error.message });
            }
        });

        socket.on('create-agent', async (settings, callback) => {
            console.log('API create agent...');
            for (let key in settings_spec) {
                if (!(key in settings)) {
                    if (settings_spec[key].required) {
                        callback({ success: false, error: `Setting ${key} is required` });
                        return;
                    }
                    else {
                        settings[key] = settings_spec[key].default;
                    }
                }
            }
            for (let key in settings) {
                if (!(key in settings_spec)) {
                    delete settings[key];
                }
            }
            if (settings.profile?.name) {
                if (settings.profile.name in agent_connections) {
                    callback({ success: false, error: 'Agent already exists' });
                    return;
                }
                // An explicit create from the UI must override a sticky
                // desired=false left by a previous stop/destroy of the same
                // name, otherwise createAgent registers the agent but never
                // starts its process and it stays offline forever.
                if (colonyCoordinator?.snapshot().agents[settings.profile.name]?.desired === false) {
                    await colonyCoordinator.updateAgent(settings.profile.name, {
                        desired: true,
                        status: 'spawning',
                    });
                }
                let returned = await mindcraft.createAgent(settings);
                callback({ success: returned.success, error: returned.error });
                let name = settings.profile.name;
                if (!returned.success && agent_connections[name]) {
                    mindcraft.destroyAgent(name);
                    delete agent_connections[name];
                }
                agentsStatusUpdate();
            }
            else {
                console.error('Agent name is required in profile');
                callback({ success: false, error: 'Agent name is required in profile' });
            }
        });

        socket.on('get-settings', (agentName, callback) => {
            if (agent_connections[agentName]) {
                callback({ settings: agent_connections[agentName].settings });
            } else {
                callback({ error: `Agent '${agentName}' not found.` });
            }
        });

        socket.on('connect-agent-process', (agentName) => {
            if (agent_connections[agentName]) {
                agent_connections[agentName].socket = socket;
                agentsStatusUpdate();
            }
        });

        socket.on('login-agent', (agentName) => {
            if (agent_connections[agentName]) {
                agent_connections[agentName].socket = socket;
                agent_connections[agentName].in_game = true;
                curAgentName = agentName;
                agentsStatusUpdate();
                // Colored nametag + model suffix, visible from any distance.
                assignModelTeam(agentName, agent_connections[agentName].settings?.profile?.model)
                    .catch(error => console.warn(`Nametag assignment failed for ${agentName}:`, error));
                if (colonyCoordinator) {
                    const colonyAgent = colonyCoordinator.snapshot().agents[agentName];
                    if (colonyAgent?.desired === false) {
                        mindcraft.stopAgent(agentName);
                        colonyCoordinator.updateAgent(agentName, { status: 'stopped' })
                            .then(() => emitColonyUpdate())
                            .catch(error => console.error(
                                `Failed to preserve stopped state for ${agentName}:`,
                                error
                            ));
                        return;
                    }
                    colonyCoordinator.updateAgent(agentName, { status: 'active' }).then(() => {
                        emitColonyUpdate();
                    }).catch(error => {
                        console.error(`Failed to activate colony agent ${agentName}:`, error);
                    });
                }
            }
            else {
                console.warn(`Unregistered agent ${agentName} tried to login`);
            }
        });

        socket.on('colony-ready', () => {
            const state = colonyCoordinator?.snapshot();
            if (curAgentName && state && !state.paused &&
                state.agents[curAgentName]?.desired &&
                agent_connections[curAgentName]) {
                sendColonyDirective(curAgentName, agent_connections[curAgentName]);
            }
        });

        socket.on('disconnect', () => {
            if (agent_connections[curAgentName]) {
                console.log(`Agent ${curAgentName} disconnected`);
                agent_connections[curAgentName].in_game = false;
                agent_connections[curAgentName].socket = null;
                agent_connections[curAgentName].recording = null;
                agentsStatusUpdate();
                if (colonyCoordinator) {
                    colonyCoordinator.updateAgent(curAgentName, { status: 'offline' })
                        .then(() => emitColonyUpdate())
                        .catch(error => console.error(
                            `Failed to mark colony agent ${curAgentName} offline:`,
                            error
                        ));
                }
            }
            if (agent_listeners.includes(socket)) {
                removeListener(socket);
            }
        });

        socket.on('chat-message', (agentName, json) => {
            const target = agent_connections[agentName];
            if (!target?.socket) {
                console.warn(`Agent ${agentName} tried to send a message but is not logged in`);
                return;
            }
            console.log(`${curAgentName} sending message to ${agentName}: ${json.message}`);
            target.socket.emit('chat-message', curAgentName, json);
        });

        socket.on('set-agent-settings', (agentName, settings) => {
            const agent = agent_connections[agentName];
            if (agent?.socket) {
                agent.setSettings(settings);
                agent.socket.emit('restart-agent');
            }
        });

        socket.on('restart-agent', (agentName) => {
            const agent = agent_connections[agentName];
            if (!agent?.socket) {
                console.warn(`Cannot restart ${agentName}: not connected`);
                return;
            }
            console.log(`Restarting agent: ${agentName}`);
            agent.socket.emit('restart-agent');
        });

        socket.on('stop-agent', async (agentName) => {
            if (colonyCoordinator?.snapshot().agents[agentName]) {
                await colonyCoordinator.updateAgent(agentName, {
                    desired: false,
                    status: 'stopped',
                });
                emitColonyUpdate();
            }
            mindcraft.stopAgent(agentName);
        });

        socket.on('start-agent', async (agentName) => {
            if (colonyCoordinator?.snapshot().agents[agentName]) {
                await colonyCoordinator.updateAgent(agentName, {
                    desired: true,
                    status: 'spawning',
                });
                emitColonyUpdate();
            }
            mindcraft.startAgent(agentName);
        });

        socket.on('destroy-agent', async (agentName) => {
            if (agent_connections[agentName]) {
                mindcraft.destroyAgent(agentName);
                delete agent_connections[agentName];
            }
            if (colonyCoordinator?.snapshot().agents[agentName]) {
                await colonyCoordinator.updateAgent(agentName, {
                    desired: false,
                    status: 'destroyed',
                });
                emitColonyUpdate();
            }
            agentsStatusUpdate();
        });

        socket.on('stop-all-agents', async () => {
            console.log('Killing all agents');
            if (colonyCoordinator) {
                closeModelOutage();
                await colonyCoordinator.pause('All agents stopped from the Mindcraft UI');
                for (const agentName of Object.keys(agent_connections)) {
                    if (colonyCoordinator.snapshot().agents[agentName]) {
                        await colonyCoordinator.updateAgent(agentName, {
                            desired: false,
                            status: 'stopped',
                        });
                    }
                }
            }
            for (let agentName in agent_connections) {
                mindcraft.stopAgent(agentName);
            }
            emitColonyUpdate();
        });

        socket.on('shutdown', () => {
            console.log('Shutting down');
            for (let agentName in agent_connections) {
                mindcraft.stopAgent(agentName);
            }
            // wait 2 seconds
            setTimeout(() => {
                console.log('Exiting MindServer');
                process.exit(0);
            }, 2000);
            
        });

		socket.on('send-message', (agentName, data) => {
			const agent = agent_connections[agentName];
			if (!agent?.socket) {
				console.warn(`Agent ${agentName} not in game, cannot send message via MindServer.`);
				return
			}
			try {
				agent.socket.emit('send-message', data)
			} catch (error) {
				console.error('Error: ', error);
			}
		});

        socket.on('bot-output', (agentName, message) => {
            io.emit('bot-output', agentName, message);
        });

        socket.on('start-recording', (agentName, options, callback) => {
            forwardRecordingCommand(agentName, 'start-recording', options || {}, callback);
        });

        socket.on('stop-recording', (agentName, callback) => {
            forwardRecordingCommand(agentName, 'stop-recording', undefined, callback);
        });

        socket.on('set-auto-recording', (agentName, enabled, callback) => {
            forwardRecordingCommand(agentName, 'set-auto-recording', Boolean(enabled), callback);
        });

        socket.on('recording-update', (agentName, status) => {
            const conn = agent_connections[agentName];
            if (conn) {
                conn.recording = status;
                agentsStatusUpdate();
            }
        });

        socket.on('list-recordings', (callback) => {
            callback(listRecordings());
        });

        socket.on('get-voices', (callback) => {
            try {
                callback(voicesOverview());
            } catch (error) {
                callback({ success: false, error: error.message });
            }
        });

        socket.on('set-voices', (config, callback) => {
            try {
                saveVoicesConfig(config || {});
                // Broadcast so other open dashboards refresh their Voices modal data.
                io.emit('voices-update');
                callback(voicesOverview());
            } catch (error) {
                callback({ success: false, error: error.message });
            }
        });

        // Generates a short ElevenLabs sample and returns base64 mp3 for
        // in-browser playback. `voice` previews a specific pool name / raw ID;
        // omitting it previews what `botName` would actually sound like.
        socket.on('preview-voice', async (options, callback) => {
            const { voice = null, botName = null, text = null } = options || {};
            try {
                if (!hasKey('ELEVENLABS_API_KEY')) {
                    throw new Error('ELEVENLABS_API_KEY is not configured');
                }
                const voiceId = resolveVoice(botName || 'preview', voice);
                const sample = String(text || `Hi, I'm ${botName || 'a Mindcraft bot'}. This is how I sound in the colony.`).slice(0, 220);
                const audio = await elevenLabsTTSConfig.sendAudioRequest(
                    sample, getVoicesConfig().elevenlabs_model, voiceId, elevenLabsTTSConfig.baseUrl
                );
                callback({ success: true, audio });
            } catch (error) {
                callback({ success: false, error: error.message });
            }
        });

        socket.on('listen-to-agents', () => {
            addListener(socket);
        });
    });

    if (host_public) {
        console.log('Public hosting not supported yet. Using localhost.');
    }
    const host = 'localhost';
    server.listen(port, host, () => {
        console.log(`MindServer running on port ${port} on host ${host}`);
    });

    return server;
}

function agentsStatusUpdate(socket) {
    if (!socket) {
        socket = io;
    }
    let agents = [];
    for (let agentName in agent_connections) {
        const conn = agent_connections[agentName];
        agents.push({
            name: agentName, 
            in_game: conn.in_game,
            viewerPort: conn.viewer_port,
            socket_connected: !!conn.socket,
            recording: conn.recording,
            // Where PovRecorder will write MP4s, so the UI can show the
            // destination before the first recording ever starts.
            recordingsFolder: path.join(projectRoot, 'bots', agentName, 'recordings')
        });
    };
    socket.emit('agents-status', agents);
}


let listenerInterval = null;
function addListener(listener_socket) {
    agent_listeners.push(listener_socket);
    if (agent_listeners.length === 1) {
        listenerInterval = setInterval(async () => {
            const states = {};
            for (let agentName in agent_connections) {
                let agent = agent_connections[agentName];
                if (agent.in_game) {
                    try {
                        const state = await requestFullState(agent);
                        states[agentName] = state ?? { error: 'Agent state request timed out' };
                    } catch (e) {
                        states[agentName] = { error: String(e) };
                    }
                }
            }
            for (let listener of agent_listeners) {
                listener.emit('state-update', states);
            }
        }, 1000);
    }
}

function removeListener(listener_socket) {
    agent_listeners.splice(agent_listeners.indexOf(listener_socket), 1);
    if (agent_listeners.length === 0) {
        clearInterval(listenerInterval);
        listenerInterval = null;
    }
}

// Optional: export these if you need access to them from other files
export const getIO = () => io;
export const getServer = () => server;
export const numStateListeners = () => agent_listeners.length;