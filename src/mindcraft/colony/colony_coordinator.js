import { randomUUID } from 'node:crypto';
import {
    appendFile,
    lstat,
    mkdir,
    readFile,
    realpath,
    rename,
    rm,
    writeFile,
} from 'node:fs/promises';
import path from 'node:path';

export const COLONY_PHASES = Object.freeze([
    'bootstrap',
    'shelter',
    'food-security',
    'iron-age',
    'enchantment',
    'nether',
    'stronghold',
    'endgame',
    'postgame-civilization',
]);

export const COLONY_PHASE_DEFINITIONS = Object.freeze({
    bootstrap: {
        title: 'Bootstrap',
        objective: 'Establish tools, shared coordinates, and immediate safety before the first night.',
        tasks: [
            ['gather-wood', 'Gather wood and craft starter tools', 'provisioner', 100],
            ['map-spawn', 'Survey spawn and publish useful coordinates', 'explorer', 90],
            ['first-food', 'Secure a renewable early food source', 'farmer', 80],
        ],
    },
    shelter: {
        title: 'Shelter and Logistics',
        objective: 'Create a defended shared base with beds, storage, lighting, and organized supplies.',
        tasks: [
            ['build-base', 'Build and light a secure shared base', 'builder', 100],
            ['storage', 'Create labeled shared storage and deposit supplies', 'logistics', 90],
            ['beds', 'Acquire beds and establish a safe respawn point', 'provisioner', 80],
        ],
    },
    'food-security': {
        title: 'Food Security',
        objective: 'Build renewable food, wood, and animal systems that sustain eight agents.',
        tasks: [
            ['crop-farm', 'Build a renewable crop farm', 'farmer', 100],
            ['tree-farm', 'Establish a renewable tree farm', 'builder', 90],
            ['animal-farm', 'Establish a useful animal breeding pen', 'farmer', 80],
        ],
    },
    'iron-age': {
        title: 'Iron Age',
        objective: 'Equip the colony with iron gear, buckets, shields, furnaces, and mining infrastructure.',
        tasks: [
            ['iron-supply', 'Mine and smelt a large shared iron reserve', 'miner', 100],
            ['iron-equipment', 'Equip agents with iron tools, armor, shields, and buckets', 'logistics', 90],
            ['mine-network', 'Build a safe, marked deep-mining route', 'miner', 80],
        ],
    },
    enchantment: {
        title: 'Diamonds and Enchantment',
        objective: 'Obtain diamonds, obsidian, enchanting, experience, and durable upgraded equipment.',
        tasks: [
            ['diamonds', 'Acquire diamonds for critical tools and enchanting', 'miner', 100],
            ['enchanting', 'Build a level-30 enchanting setup', 'enchanter', 90],
            ['xp-source', 'Build a reliable experience source', 'builder', 80],
        ],
    },
    nether: {
        title: 'Nether Expedition',
        objective: 'Create safe Nether logistics and obtain blaze rods, nether wart, and brewing capability.',
        tasks: [
            ['nether-route', 'Secure and mark the portal and Nether travel route', 'explorer', 100],
            ['fortress', 'Find a fortress and obtain blaze rods and nether wart', 'combat', 90],
            ['brewing', 'Build and stock a brewing station', 'enchanter', 80],
        ],
    },
    stronghold: {
        title: 'Stronghold Campaign',
        objective: 'Gather eyes of ender, locate the stronghold, and prepare an expedition cache.',
        tasks: [
            ['ender-pearls', 'Gather enough ender pearls and eyes of ender', 'combat', 100],
            ['locate-stronghold', 'Locate and map a safe route to the stronghold', 'explorer', 90],
            ['end-cache', 'Prepare food, beds, blocks, bows, and backup equipment', 'logistics', 80],
        ],
    },
    endgame: {
        title: 'The End',
        objective: 'Defeat the Ender Dragon, establish safe End access, and recover elytra and shulker shells.',
        tasks: [
            ['dragon', 'Coordinate and defeat the Ender Dragon', 'combat', 100],
            ['end-gateway', 'Secure the End spawn and gateway routes', 'builder', 90],
            ['end-city', 'Raid an End city for elytra and shulker shells', 'explorer', 80],
        ],
    },
    'postgame-civilization': {
        title: 'Advanced Civilization',
        objective: 'Continuously expand automation, transport, trade, defenses, monuments, and technology.',
        tasks: [
            ['villager-hall', 'Build and improve a protected villager trading hall', 'trader', 100],
            ['automation', 'Build a new high-value automated farm or redstone system', 'redstone', 90],
            ['infrastructure', 'Expand roads, rail, portals, defenses, or public works', 'builder', 80],
        ],
    },
});

const PHASE_ACCEPTANCE = Object.freeze({
    'bootstrap:gather-wood': 'A shared crafting table exists and the colony has working wooden or stone pickaxes, axes, and spare logs at a reported cache.',
    'bootstrap:map-spawn': 'Spawn, base candidate, useful resources, hazards, and at least three exact coordinates are recorded in shared progress.',
    'bootstrap:first-food': 'An irrigated planted crop plot or an enclosed pair of breedable animals exists; hunting one animal or collecting partial materials is not renewable food.',
    'shelter:build-base': 'The shared base has complete walls, roof, floor, entrance, interior lighting, and enough enclosed space to survive a hostile night.',
    'shelter:storage': 'Shared chests are placed at published coordinates and contain organized deposited supplies from the colony.',
    'shelter:beds': 'At least three beds are crafted and placed safely inside the shared base, with their coordinates published.',
    'food-security:crop-farm': 'A protected irrigated farm has at least twenty planted crop blocks and a path for harvesting and replanting.',
    'food-security:tree-farm': 'At least four renewable tree planting spots are prepared and planted near the base.',
    'food-security:animal-farm': 'A secure pen contains at least two breedable animals of the same species plus a reliable feed source.',
    'iron-age:iron-supply': 'At least sixty-four iron ingots are smelted or deposited in shared storage and the mine route is documented.',
    'iron-age:iron-equipment': 'At least three active workers have iron tools, shields, buckets, and meaningful iron armor.',
    'iron-age:mine-network': 'A lit, navigable deep-mining route connects the base to productive iron and diamond levels with coordinates recorded.',
    'enchantment:diamonds': 'The colony has a diamond pickaxe, an enchanting-table diamond reserve, and the discovery coordinates recorded.',
    'enchantment:enchanting': 'An enchanting table with fifteen correctly placed bookshelves can produce level-30 enchantments.',
    'enchantment:xp-source': 'A repeatable, safe experience source is operational and its use is documented.',
    'nether:nether-route': 'Both sides of the portal are enclosed and lit, with a marked safe route and coordinates.',
    'nether:fortress': 'A Nether fortress route is recorded and blaze rods plus nether wart are returned to shared storage.',
    'nether:brewing': 'A brewing station is placed and stocked with blaze powder, bottles, nether wart, and at least one useful potion.',
    'stronghold:ender-pearls': 'Enough eyes of ender to locate and activate the portal are stored at the expedition cache.',
    'stronghold:locate-stronghold': 'The stronghold and portal room coordinates are recorded and a safe route reaches them.',
    'stronghold:end-cache': 'The stronghold cache contains complete combat gear, food, blocks, bows, arrows, beds, and backup equipment.',
    'endgame:dragon': 'The Ender Dragon is defeated and the exit portal is safely accessible.',
    'endgame:end-gateway': 'The End spawn and gateway routes have safe platforms, marked paths, and recorded coordinates.',
    'endgame:end-city': 'At least one elytra and useful shulker shells are returned to shared storage.',
    'postgame-civilization:villager-hall': 'A protected trading hall has useful renewable trades and a safe transport or breeding pipeline.',
    'postgame-civilization:automation': 'A new automated system is operational, tested, documented, and deposits useful output.',
    'postgame-civilization:infrastructure': 'A substantial transport, defense, utility, or public-works project is finished and connected to colony infrastructure.',
});

const ARTIFACT_AREAS = new Set(['notes', 'blueprints', 'code']);
const ARTIFACT_EXTENSIONS = new Set(['.md', '.txt', '.json', '.js']);
const MAX_ARTIFACT_BYTES = 64 * 1024;
const ACTIVE_AGENT_STATUSES = new Set(['active', 'busy', 'idle', 'spawning']);
const TASK_STATUSES = new Set(['proposed', 'claimed', 'completed', 'failed']);

function clone(value) {
    return structuredClone(value);
}

function defaultState(maxAgents, now) {
    return {
        version: 1,
        paused: false,
        pauseReason: null,
        phase: COLONY_PHASES[0],
        epoch: 1,
        maxAgents,
        agents: {},
        tasks: {},
        spawn: {
            lastRequestedAt: null,
            requests: [],
        },
        progress: [],
        createdAt: now,
        updatedAt: now,
    };
}

function assertNonEmptyString(value, name) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(`${name} must be a non-empty string`);
    }
}

function assertState(state) {
    if (!state || state.version !== 1 || !COLONY_PHASES.includes(state.phase)) {
        throw new Error('Unsupported or invalid colony state');
    }
    if (!Number.isInteger(state.maxAgents) || state.maxAgents < 1) {
        throw new Error('Invalid maxAgents in colony state');
    }
}

function hasRequiredCompletionEvidence(task, result) {
    const text = result.toLowerCase();
    switch (task.id) {
        case 'bootstrap-first-food': {
            const animalPen = /\b(2|two)\b/.test(text) &&
                /\b(chickens?|cows?|sheep|pigs?)\b/.test(text) &&
                /\b(pen|enclos|fenced)\b/.test(text);
            const cropFarm = /\b(20|twenty)\b/.test(text) &&
                /\b(crops?|wheat|carrots?|potatoes?|beetroots?)\b/.test(text) &&
                /\b(planted|irrigated|farm)\b/.test(text);
            return animalPen || cropFarm;
        }
        case 'shelter-build-base':
            return ['wall', 'roof', 'light', 'door']
                .every(evidence => text.includes(evidence));
        case 'shelter-storage':
            return /\bchests?\b/.test(text) &&
                /\b(deposited|stored|organized)\b/.test(text) &&
                /\bx\s*[:=]\s*-?\d+/.test(text);
        case 'shelter-beds':
            return /\b(3|three)\b/.test(text) &&
                /\bbeds?\b/.test(text) &&
                /\b(placed|inside|base)\b/.test(text);
        case 'food-security-crop-farm':
            return /\b(20|twenty)\b/.test(text) &&
                /\bplanted\b/.test(text) &&
                /\b(irrigated|water)\b/.test(text);
        case 'food-security-tree-farm':
            return /\b(4|four)\b/.test(text) &&
                /\bsaplings?\b/.test(text) &&
                /\b(planted|planting spots?)\b/.test(text);
        case 'food-security-animal-farm':
            return /\b(2|two)\b/.test(text) &&
                /\b(chickens?|cows?|sheep|pigs?)\b/.test(text) &&
                /\b(pen|enclos|fenced)\b/.test(text) &&
                /\b(breed|feed|wheat|seeds?|carrots?)\b/.test(text);
        default:
            return true;
    }
}

export class ColonyCoordinator {
    constructor(options = {}) {
        const {
            root,
            maxAgents = 8,
            leaseMs = 5 * 60 * 1000,
            spawnCooldownMs = 60 * 1000,
            clock = () => Date.now(),
            idFactory = randomUUID,
            state,
        } = options;

        assertNonEmptyString(root, 'root');
        if (!Number.isInteger(maxAgents) || maxAgents < 1) {
            throw new RangeError('maxAgents must be a positive integer');
        }
        if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
            throw new RangeError('leaseMs must be positive');
        }
        if (!Number.isFinite(spawnCooldownMs) || spawnCooldownMs < 0) {
            throw new RangeError('spawnCooldownMs cannot be negative');
        }

        this.root = path.resolve(root);
        this.statePath = path.join(this.root, 'state.json');
        this.planPath = path.join(this.root, 'plan.md');
        this.journalPath = path.join(this.root, 'journal.jsonl');
        this.leaseMs = leaseMs;
        this.spawnCooldownMs = spawnCooldownMs;
        this.clock = clock;
        this.idFactory = idFactory;
        this.state = state ? clone(state) : defaultState(maxAgents, this.clock());
        assertState(this.state);
        this._operation = Promise.resolve();
    }

    static async create(options) {
        const coordinator = new ColonyCoordinator(options);
        await coordinator._initialize();
        return coordinator;
    }

    static async load(options) {
        assertNonEmptyString(options?.root, 'root');
        const statePath = path.join(path.resolve(options.root), 'state.json');
        const state = JSON.parse(await readFile(statePath, 'utf8'));
        state.epoch ??= 1;
        state.progress ??= [];
        state.pauseReason ??= null;
        for (const agent of Object.values(state.agents ?? {})) {
            agent.desired ??= true;
            agent.profile ??= null;
        }
        if (options.maxAgents !== undefined) {
            if (!Number.isInteger(options.maxAgents) || options.maxAgents < 1) {
                throw new RangeError('maxAgents must be a positive integer');
            }
            state.maxAgents = options.maxAgents;
        }
        assertState(state);
        const coordinator = new ColonyCoordinator({
            ...options,
            state,
        });
        await coordinator._ensureDirectories();
        await coordinator.expireLeases();
        await coordinator.ensurePhaseTasks();
        await coordinator.reconcilePhase();
        return coordinator;
    }

    snapshot() {
        return clone(this.state);
    }

    view() {
        const state = this.snapshot();
        const phase = COLONY_PHASE_DEFINITIONS[state.phase];
        return {
            ...state,
            phase: {
                id: state.phase,
                title: phase.title,
                objective: phase.objective,
                epoch: state.epoch,
            },
            agents: Object.values(state.agents),
            tasks: Object.values(state.tasks).sort((left, right) =>
                right.priority - left.priority
            ),
            recentProgress: state.progress.slice(-20).reverse(),
        };
    }

    serialize() {
        return JSON.stringify(this.state, null, 2);
    }

    async registerAgent(agentId, role, status = 'active', metadata = {}) {
        assertNonEmptyString(agentId, 'agentId');
        assertNonEmptyString(role, 'role');
        assertNonEmptyString(status, 'status');
        return this._mutate('agent.registered', { agentId, role, status }, now => {
            const existing = this.state.agents[agentId];
            const becomingManaged = !existing && metadata.desired !== false;
            if (becomingManaged && this._desiredAgentCount() >= this.state.maxAgents) {
                throw new Error('Agent cap reached');
            }
            const effectiveStatus = existing?.desired === false
                ? existing.status
                : status;
            const becomingActive = !ACTIVE_AGENT_STATUSES.has(existing?.status) &&
                ACTIVE_AGENT_STATUSES.has(effectiveStatus);
            if (becomingActive &&
                this._activeAgentCount() >= this.state.maxAgents) {
                throw new Error('Agent cap reached');
            }
            this.state.agents[agentId] = {
                id: agentId,
                role,
                status: effectiveStatus,
                desired: existing?.desired ?? metadata.desired ?? true,
                profile: metadata.profile ?? existing?.profile ?? null,
                heartbeatAt: now,
                registeredAt: existing?.registeredAt ?? now,
                updatedAt: now,
            };
            return clone(this.state.agents[agentId]);
        });
    }

    async updateAgent(agentId, updates = {}) {
        assertNonEmptyString(agentId, 'agentId');
        return this._mutate('agent.updated', { agentId, updates }, now => {
            const agent = this._requireAgent(agentId);
            if (updates.role !== undefined) {
                assertNonEmptyString(updates.role, 'role');
                agent.role = updates.role;
            }
            if (updates.status !== undefined) {
                assertNonEmptyString(updates.status, 'status');
                const becomingActive = !ACTIVE_AGENT_STATUSES.has(agent.status) &&
                    ACTIVE_AGENT_STATUSES.has(updates.status);
                if (becomingActive && this._activeAgentCount() >= this.state.maxAgents) {
                    throw new Error('Agent cap reached');
                }
                agent.status = updates.status;
            }
            if (updates.desired !== undefined) {
                agent.desired = Boolean(updates.desired);
            }
            if (updates.profile !== undefined) {
                agent.profile = clone(updates.profile);
            }
            agent.updatedAt = now;
            return clone(agent);
        });
    }

    async heartbeat(agentId, status) {
        assertNonEmptyString(agentId, 'agentId');
        return this._mutate('agent.heartbeat', { agentId, status }, now => {
            const agent = this._requireAgent(agentId);
            if (status !== undefined) {
                assertNonEmptyString(status, 'status');
                const becomingActive = !ACTIVE_AGENT_STATUSES.has(agent.status) &&
                    ACTIVE_AGENT_STATUSES.has(status);
                if (becomingActive && this._activeAgentCount() >= this.state.maxAgents) {
                    throw new Error('Agent cap reached');
                }
                agent.status = status;
            }
            agent.heartbeatAt = now;
            agent.updatedAt = now;
            for (const task of Object.values(this.state.tasks)) {
                if (task.status === 'claimed' && task.claimedBy === agentId) {
                    task.leaseExpiresAt = now + this.leaseMs;
                    task.updatedAt = now;
                }
            }
            return clone(agent);
        }, { journalWhen: () => false });
    }

    async proposeTask(proposal) {
        assertNonEmptyString(proposal?.title, 'title');
        return this._mutate('task.proposed', { proposal }, now => {
            const id = proposal.id ?? this.idFactory();
            assertNonEmptyString(id, 'task id');
            if (this.state.tasks[id]) {
                throw new Error(`Task already exists: ${id}`);
            }
            const task = {
                id,
                title: proposal.title,
                description: proposal.description ?? '',
                phase: proposal.phase ?? this.state.phase,
                priority: proposal.priority ?? 0,
                role: proposal.role ?? null,
                required: proposal.required ?? false,
                status: 'proposed',
                createdAt: now,
                updatedAt: now,
                claimedBy: null,
                leaseExpiresAt: null,
                result: null,
                error: null,
            };
            if (!COLONY_PHASES.includes(task.phase)) {
                throw new Error(`Unknown phase: ${task.phase}`);
            }
            this.state.tasks[id] = task;
            return clone(task);
        });
    }

    currentTaskFor(agentId) {
        const now = this.clock();
        return clone(Object.values(this.state.tasks).find(task =>
            task.claimedBy === agentId &&
            task.status === 'claimed' &&
            task.phase === this.state.phase &&
            task.leaseExpiresAt > now
        ) ?? null);
    }

    async claimNextTask(agentId) {
        assertNonEmptyString(agentId, 'agentId');
        return this._mutate('task.claimed-next', { agentId }, now => {
            if (this.state.paused) {
                throw new Error('Colony is paused');
            }
            const agent = this._requireAgent(agentId);
            const current = Object.values(this.state.tasks).find(task =>
                task.claimedBy === agentId &&
                task.status === 'claimed' &&
                task.phase === this.state.phase &&
                task.leaseExpiresAt > now
            );
            if (current) return clone(current);
            const next = Object.values(this.state.tasks)
                .filter(task => task.status === 'proposed' && task.phase === this.state.phase)
                .sort((left, right) => {
                    const leftFit = left.role === agent.role ? 1 : 0;
                    const rightFit = right.role === agent.role ? 1 : 0;
                    return rightFit - leftFit || right.priority - left.priority;
                })[0];
            if (!next) {
                throw new Error('No colony task is currently available');
            }
            next.status = 'claimed';
            next.claimedBy = agentId;
            next.leaseExpiresAt = now + this.leaseMs;
            next.updatedAt = now;
            return clone(next);
        });
    }

    async recordProgress(agentId, summary) {
        assertNonEmptyString(agentId, 'agentId');
        assertNonEmptyString(summary, 'summary');
        return this._mutate('progress.recorded', { agentId, summary }, now => {
            this._requireAgent(agentId);
            const entry = { id: this.idFactory(), agentId, summary, at: now };
            this.state.progress.push(entry);
            this.state.progress = this.state.progress.slice(-200);
            return clone(entry);
        });
    }

    async claimTask(taskId, agentId, leaseMs = this.leaseMs) {
        assertNonEmptyString(taskId, 'taskId');
        assertNonEmptyString(agentId, 'agentId');
        if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
            throw new RangeError('leaseMs must be positive');
        }
        return this._mutate('task.claimed', { taskId, agentId, leaseMs }, now => {
            if (this.state.paused) {
                throw new Error('Colony is paused');
            }
            this._requireAgent(agentId);
            const task = this._requireTask(taskId);
            this._expireTask(task, now);
            if (task.status !== 'proposed') {
                throw new Error(`Task is not claimable: ${task.status}`);
            }
            task.status = 'claimed';
            task.claimedBy = agentId;
            task.leaseExpiresAt = now + leaseMs;
            task.updatedAt = now;
            return clone(task);
        });
    }

    async completeTask(taskId, agentId, result = null) {
        assertNonEmptyString(result, 'result');
        const incompleteLanguage = /\b(still|not yet|in progress|continue(?:s|d)? to|remaining work|need(?:s)? to|starting to|attempting to|only \d+)\b/i;
        if (incompleteLanguage.test(result)) {
            throw new Error(
                'Completion rejected because the summary describes unfinished work. Record progress instead and continue the task.'
            );
        }
        const task = this._requireTask(taskId);
        if (task.required && !hasRequiredCompletionEvidence(task, result)) {
            throw new Error(
                `Completion rejected because the summary does not prove the task acceptance criteria: ${task.description}`
            );
        }
        return this._finishTask(taskId, agentId, 'completed', { result });
    }

    async failTask(taskId, agentId, error) {
        assertNonEmptyString(error, 'error');
        return this._finishTask(taskId, agentId, 'failed', { error });
    }

    async reopenTask(taskId, reason) {
        assertNonEmptyString(taskId, 'taskId');
        assertNonEmptyString(reason, 'reason');
        return this._mutate('task.reopened', { taskId, reason }, now => {
            const task = this._requireTask(taskId);
            task.status = 'proposed';
            task.claimedBy = null;
            task.leaseExpiresAt = null;
            task.result = null;
            task.error = reason;
            task.updatedAt = now;
            delete task.finishedAt;
            return clone(task);
        });
    }

    async reconcilePhase() {
        const previousPhase = this.state.phase;
        return this._mutate('phase.reconciled', {}, () => {
            const currentIndex = COLONY_PHASES.indexOf(this.state.phase);
            for (let index = 0; index <= currentIndex; index += 1) {
                const phase = COLONY_PHASES[index];
                const required = Object.values(this.state.tasks)
                    .filter(task => task.phase === phase && task.required === true);
                if (required.some(task => task.status !== 'completed')) {
                    this.state.phase = phase;
                    this._releaseOutOfPhaseClaims();
                    this._seedPhaseTasks();
                    return phase;
                }
            }
            return this.state.phase;
        }, { journalWhen: phase => phase !== previousPhase });
    }

    async expireLeases() {
        return this._mutate('leases.expired', {}, now => {
            const expired = [];
            for (const task of Object.values(this.state.tasks)) {
                if (this._expireTask(task, now)) {
                    expired.push(task.id);
                }
            }
            return expired;
        }, { journalWhen: result => result.length > 0 });
    }

    async pause(reason = '') {
        return this._mutate('colony.paused', { reason }, () => {
            this.state.paused = true;
            this.state.pauseReason = reason || null;
            return this.snapshot();
        });
    }

    async resume() {
        return this._mutate('colony.resumed', {}, () => {
            this.state.paused = false;
            this.state.pauseReason = null;
            return this.snapshot();
        });
    }

    async advancePhase(targetPhase) {
        return this._mutate('phase.advanced', { targetPhase }, () => {
            const currentIndex = COLONY_PHASES.indexOf(this.state.phase);
            const targetIndex = targetPhase === undefined
                ? currentIndex + 1
                : COLONY_PHASES.indexOf(targetPhase);
            if (targetIndex < 0 || targetIndex >= COLONY_PHASES.length) {
                throw new Error('No valid next phase');
            }
            if (targetIndex !== currentIndex + 1) {
                throw new Error('Phases must advance exactly one step');
            }
            this.state.phase = COLONY_PHASES[targetIndex];
            this._releaseOutOfPhaseClaims();
            this._seedPhaseTasks();
            return this.state.phase;
        });
    }

    async ensurePhaseTasks() {
        return this._mutate(
            'phase.tasks-seeded',
            { phase: this.state.phase },
            () => this._seedPhaseTasks(),
            { journalWhen: result => result.length > 0 }
        );
    }

    async requestSpawn(role, requestedBy = null) {
        assertNonEmptyString(role, 'role');
        return this._mutate('spawn.requested', { role, requestedBy }, now => {
            if (this.state.paused) {
                return { accepted: false, reason: 'paused' };
            }
            const pending = this.state.spawn.requests.filter(request =>
                request.status === 'pending'
            ).length;
            if (this._desiredAgentCount() + pending >= this.state.maxAgents) {
                return { accepted: false, reason: 'max-agents' };
            }
            const last = this.state.spawn.lastRequestedAt;
            if (last !== null && now - last < this.spawnCooldownMs) {
                return {
                    accepted: false,
                    reason: 'cooldown',
                    retryAt: last + this.spawnCooldownMs,
                };
            }
            const request = {
                id: this.idFactory(),
                role,
                requestedBy,
                status: 'pending',
                requestedAt: now,
            };
            this.state.spawn.requests.push(request);
            this.state.spawn.lastRequestedAt = now;
            return { accepted: true, request: clone(request) };
        });
    }

    async resolveSpawnRequest(requestId, status, agentId = null) {
        assertNonEmptyString(requestId, 'requestId');
        if (!['spawned', 'rejected', 'failed'].includes(status)) {
            throw new Error(`Invalid spawn request status: ${status}`);
        }
        return this._mutate('spawn.resolved', { requestId, status, agentId }, now => {
            const request = this.state.spawn.requests.find(item => item.id === requestId);
            if (!request) {
                throw new Error(`Unknown spawn request: ${requestId}`);
            }
            if (request.status !== 'pending') {
                throw new Error('Spawn request is already resolved');
            }
            request.status = status;
            request.agentId = agentId;
            request.resolvedAt = now;
            return clone(request);
        });
    }

    directiveFor(agentId) {
        const agent = this._requireAgent(agentId);
        const now = this.clock();
        const phase = COLONY_PHASE_DEFINITIONS[this.state.phase];
        const claimed = Object.values(this.state.tasks)
            .filter(task => task.claimedBy === agentId && task.status === 'claimed' &&
                task.phase === this.state.phase && task.leaseExpiresAt > now)
            .sort((left, right) => right.priority - left.priority);
        const available = Object.values(this.state.tasks)
            .filter(task => task.status === 'proposed' && task.phase === this.state.phase)
            .sort((left, right) => {
                const leftFit = left.role === agent.role ? 1 : 0;
                const rightFit = right.role === agent.role ? 1 : 0;
                return rightFit - leftFit || right.priority - left.priority;
            });
        const instruction = this.state.paused
            ? `Pause autonomous work, remain safe, and continue heartbeats.${
                this.state.pauseReason ? ` Reason: ${this.state.pauseReason}` : ''}`
            : claimed.length > 0
                ? `Continue task ${claimed[0].id}: ${claimed[0].description}`
                : available.length > 0
                    ? `Claim the highest-priority suitable task, starting with ${available[0].id}.`
                    : `Propose a safe task that advances the ${this.state.phase} phase.`;
        const directive = {
            paused: this.state.paused,
            pauseReason: this.state.pauseReason,
            phase: this.state.phase,
            phaseTitle: phase.title,
            objective: phase.objective,
            agent: clone(agent),
            instruction,
            claimedTasks: clone(claimed),
            availableTasks: clone(available),
        };
        directive.prompt = [
            `You are ${agentId}, the colony's ${agent.role}.`,
            `Shared phase: ${phase.title}. Objective: ${phase.objective}`,
            instruction,
            'Operate continuously in legitimate survival: gather, craft, build, explore, fight, farm, trade, and automate.',
            'Use !colonyStatus and !colonyTask whenever context is unclear.',
            'Claim work before starting it. Record partial progress, but call !completeColonyTask only after the whole objective is objectively finished; never mark plans, attempts, or partial materials complete.',
            'Record discoveries with !recordColonyProgress and publish durable notes, blueprints, or code artifacts when useful.',
            'Coordinate material dependencies and shared locations with other bots using !startConversation.',
            'Keep conversations brief: exchange actionable information, call !endConversation, then resume physical work.',
            'Do not idle, duplicate claimed work, use cheats, or stop the colony goal. Issue exactly one useful command per response.',
        ].join('\n');
        return directive;
    }

    async writeArtifact(relativePath, content) {
        assertNonEmptyString(relativePath, 'relativePath');
        if (typeof content !== 'string' && !Buffer.isBuffer(content)) {
            throw new TypeError('content must be a string or Buffer');
        }
        if (Buffer.byteLength(content) > MAX_ARTIFACT_BYTES) {
            throw new Error(`Artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`);
        }
        return this._enqueue(async () => {
            await this._ensureDirectories();
            const normalized = relativePath.replaceAll('\\', '/');
            const parts = normalized.split('/');
            if (path.isAbsolute(relativePath) || parts.includes('..') ||
                parts.includes('.') || !ARTIFACT_AREAS.has(parts[0]) ||
                parts.length < 2 || parts.some(part => part === '')) {
                throw new Error('Artifact path must remain within notes, blueprints, or code');
            }
            if (!ARTIFACT_EXTENSIONS.has(path.extname(parts.at(-1)).toLowerCase())) {
                throw new Error('Artifact extension must be .md, .txt, .json, or .js');
            }
            const colonyRoot = this.root;
            const destination = path.resolve(colonyRoot, ...parts);
            if (!destination.startsWith(`${colonyRoot}${path.sep}`)) {
                throw new Error('Artifact path escapes colony root');
            }
            const parent = path.dirname(destination);
            await mkdir(parent, { recursive: true });
            const actualColonyRoot = await realpath(colonyRoot);
            const actualParent = await realpath(parent);
            if (actualParent !== actualColonyRoot &&
                !actualParent.startsWith(`${actualColonyRoot}${path.sep}`)) {
                throw new Error('Artifact path resolves outside colony root');
            }
            try {
                const targetStat = await lstat(destination);
                if (targetStat.isSymbolicLink()) {
                    throw new Error('Artifact target cannot be a symbolic link');
                }
            } catch (error) {
                if (error.code !== 'ENOENT') {
                    throw error;
                }
            }
            await this._atomicWrite(destination, content);
            await this._appendJournal({
                at: this.clock(),
                type: 'artifact.written',
                data: { path: normalized },
            });
            return destination;
        });
    }

    async persist() {
        return this._enqueue(async () => {
            await this._persistFiles();
            return this.snapshot();
        });
    }

    async _initialize() {
        await this._ensureDirectories();
        this._seedPhaseTasks();
        await this._persistFiles();
        await this._appendJournal({
            at: this.clock(),
            type: 'colony.initialized',
            data: { phase: this.state.phase },
        });
    }

    async _ensureDirectories() {
        await mkdir(this.root, { recursive: true });
        await Promise.all([...ARTIFACT_AREAS].map(area =>
            mkdir(path.join(this.root, area), { recursive: true })
        ));
    }

    async _finishTask(taskId, agentId, status, details) {
        assertNonEmptyString(taskId, 'taskId');
        assertNonEmptyString(agentId, 'agentId');
        return this._mutate(`task.${status}`, { taskId, agentId, ...details }, now => {
            const task = this._requireTask(taskId);
            this._expireTask(task, now);
            if (task.status !== 'claimed' || task.claimedBy !== agentId) {
                throw new Error('Task is not claimed by this agent');
            }
            task.status = status === 'failed' ? 'proposed' : status;
            task.result = details.result ?? null;
            task.error = details.error ?? null;
            task.attempts = (task.attempts ?? 0) + (status === 'failed' ? 1 : 0);
            task.claimedBy = status === 'failed' ? null : task.claimedBy;
            task.leaseExpiresAt = null;
            task.updatedAt = now;
            task.finishedAt = now;
            if (status === 'completed') {
                this._advanceAfterPhaseCompletion();
            }
            return clone(task);
        });
    }

    _advanceAfterPhaseCompletion() {
        const phaseTasks = Object.values(this.state.tasks)
            .filter(task => task.phase === this.state.phase && task.required === true);
        if (phaseTasks.length === 0 ||
            phaseTasks.some(task => task.status !== 'completed')) {
            return null;
        }
        const currentIndex = COLONY_PHASES.indexOf(this.state.phase);
        if (currentIndex < COLONY_PHASES.length - 1) {
            this.state.phase = COLONY_PHASES[currentIndex + 1];
        } else {
            this.state.epoch += 1;
        }
        this._releaseOutOfPhaseClaims();
        this._seedPhaseTasks();
        return this.state.phase;
    }

    _seedPhaseTasks() {
        const definition = COLONY_PHASE_DEFINITIONS[this.state.phase];
        const epochSuffix = this.state.phase === 'postgame-civilization'
            ? `-e${this.state.epoch}`
            : '';
        const created = [];
        for (const [slug, title, role, priority] of definition.tasks) {
            const id = `${this.state.phase}-${slug}${epochSuffix}`;
            const acceptance = PHASE_ACCEPTANCE[`${this.state.phase}:${slug}`];
            const description = `${title}. Completion criteria: ${acceptance}`;
            if (this.state.tasks[id]) {
                this.state.tasks[id].required = true;
                this.state.tasks[id].description = description;
                continue;
            }
            this.state.tasks[id] = {
                id,
                title,
                description,
                phase: this.state.phase,
                priority,
                role,
                required: true,
                status: 'proposed',
                createdAt: this.clock(),
                updatedAt: this.clock(),
                claimedBy: null,
                leaseExpiresAt: null,
                result: null,
                error: null,
                attempts: 0,
            };
            created.push(id);
        }
        return created;
    }

    _releaseOutOfPhaseClaims() {
        const now = this.clock();
        for (const task of Object.values(this.state.tasks)) {
            if (task.status === 'claimed' && task.phase !== this.state.phase) {
                task.status = 'proposed';
                task.claimedBy = null;
                task.leaseExpiresAt = null;
                task.updatedAt = now;
            }
        }
    }

    async _mutate(type, data, operation, options = {}) {
        return this._enqueue(async () => {
            const before = clone(this.state);
            const now = this.clock();
            let persisted = false;
            try {
                const result = operation(now);
                this.state.updatedAt = now;
                await this._persistFiles();
                persisted = true;
                if (!options.journalWhen || options.journalWhen(result)) {
                    try {
                        await this._appendJournal({ at: now, type, data });
                    } catch (error) {
                        console.error(`Colony journal append failed for ${type}:`, error);
                    }
                }
                return result;
            } catch (error) {
                if (!persisted) {
                    this.state = before;
                }
                throw error;
            }
        });
    }

    _enqueue(operation) {
        const result = this._operation.then(operation, operation);
        this._operation = result.catch(() => {});
        return result;
    }

    _activeAgentCount() {
        return Object.values(this.state.agents)
            .filter(agent => ACTIVE_AGENT_STATUSES.has(agent.status)).length;
    }

    _desiredAgentCount() {
        return Object.values(this.state.agents)
            .filter(agent => agent.desired !== false).length;
    }

    _expireTask(task, now) {
        if (task.status === 'claimed' && task.leaseExpiresAt <= now) {
            task.status = 'proposed';
            task.claimedBy = null;
            task.leaseExpiresAt = null;
            task.updatedAt = now;
            return true;
        }
        return false;
    }

    _requireAgent(agentId) {
        const agent = this.state.agents[agentId];
        if (!agent) {
            throw new Error(`Unknown agent: ${agentId}`);
        }
        return agent;
    }

    _requireTask(taskId) {
        const task = this.state.tasks[taskId];
        if (!task || !TASK_STATUSES.has(task.status)) {
            throw new Error(`Unknown task: ${taskId}`);
        }
        return task;
    }

    async _persistFiles() {
        await this._ensureDirectories();
        await this._atomicWrite(this.statePath, `${this.serialize()}\n`);
        await this._atomicWrite(this.planPath, this._renderPlan());
    }

    async _atomicWrite(destination, content) {
        const temporary = `${destination}.${process.pid}.${this.idFactory()}.tmp`;
        try {
            await writeFile(temporary, content);
            await rename(temporary, destination);
        } finally {
            await rm(temporary, { force: true });
        }
    }

    async _appendJournal(event) {
        await appendFile(this.journalPath, `${JSON.stringify(event)}\n`, 'utf8');
    }

    _renderPlan() {
        const phase = COLONY_PHASE_DEFINITIONS[this.state.phase];
        const tasks = Object.values(this.state.tasks);
        const open = tasks.filter(task =>
            task.phase === this.state.phase &&
            (task.status === 'proposed' || task.status === 'claimed')
        );
        const lines = [
            '# Colony Plan',
            '',
            `- Phase: ${phase.title} (${this.state.phase})`,
            `- Objective: ${phase.objective}`,
            `- Civilization epoch: ${this.state.epoch}`,
            `- Status: ${this.state.paused
                ? `paused${this.state.pauseReason ? ` (${this.state.pauseReason})` : ''}`
                : 'running'}`,
            `- Agents: ${this._activeAgentCount()}/${this.state.maxAgents}`,
            '',
            '## Open Tasks',
            '',
        ];
        if (open.length === 0) {
            lines.push('- None');
        } else {
            for (const task of open.sort((left, right) => right.priority - left.priority)) {
                const owner = task.claimedBy ? ` (${task.claimedBy})` : '';
                const role = task.role ? ` [${task.role}]` : '';
                lines.push(`- [${task.status}] ${task.id}: ${task.title}${role}${owner}`);
            }
        }
        lines.push('', '## Recent Progress', '');
        if (this.state.progress.length === 0) {
            lines.push('- None yet');
        } else {
            for (const entry of this.state.progress.slice(-20).reverse()) {
                lines.push(`- ${entry.agentId}: ${entry.summary}`);
            }
        }
        return `${lines.join('\n')}\n`;
    }
}

export default ColonyCoordinator;
