import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CursorSDK } from '../src/models/cursor.js';
import { wordOverlapScore } from '../src/utils/text.js';

const DEFAULT_BASELINE = 'f40bcf3';
const DEFAULT_TREATMENT = '9efd096';
const DEFAULT_MODEL = 'gpt-5.6-luna';

const MEMORY_FIXTURES = [
    {
        id: 'blocked-crop-route',
        oldMemory: 'Crop plot task is active near the shared safe area.',
        turns: [
            {
                role: 'system',
                content: 'Task: build an irrigated planted crop plot near base 5,69,13 and chest 4,70,14.'
            },
            {
                role: 'system',
                content: 'Path to 5,69,13 failed at -12.4,69,21.7: stone blocks the route and current tools cannot break stone.'
            },
            {
                role: 'assistant',
                content: 'Retried the same route; pathfinding failed again.'
            },
            {
                role: 'system',
                content: 'A miner broke the blocking stone. The next navigation attempt reached the plot. It remains unplanted and unwatered.'
            }
        ],
        facts: [
            /crop plot/i,
            /(5\s*,\s*69\s*,\s*13|base)/i,
            /(stone|cannot break)/i,
            /(unplanted|not planted|still needs? planting|incomplete)/i
        ],
        policies: [
            /((do not|don'?t|never|avoid).{0,100}(retry|same route)|(instead of).{0,60}retry)/i,
            /(alternate|reroute|miner|proper tool|stone pick)/i
        ],
        incidentalCoordinates: ['-12.4,69,21.7']
    },
    {
        id: 'flooded-shared-hall',
        oldMemory: 'Shared halls are under construction.',
        turns: [
            {
                role: 'system',
                content: 'Water/cobblestone trap at -22,62,-33 blocks the shared-hall route.'
            },
            {
                role: 'assistant',
                content: 'Repeated navigation to -22,62,-33 stuck near -15,44,-33.'
            },
            {
                role: 'system',
                content: 'Bot moved to dry anchor -14,41,-16, climbed two blocks, placed a cobblestone path, and reached -9,45,-11.'
            },
            {
                role: 'assistant',
                content: 'The elevated path crossed the flooded section successfully.'
            }
        ],
        facts: [
            /shared.?hall/i,
            /(water|flood)/i,
            /(dry anchor|safe anchor|-14\s*,\s*41\s*,\s*-16)/i,
            /(elevat|bridge|rerout)/i
        ],
        policies: [
            /((elevat|higher|above).{0,90}(water|flood|trap|route|bridg)|(water|flood|trap).{0,90}(elevat|higher|above|bridg|path))/i,
            /(bridg|reroute|build|use|from).{0,70}(dry|anchor|water|flood|trap)/i
        ],
        incidentalCoordinates: ['-15,44,-33', '-9,45,-11']
    },
    {
        id: 'chest-timeout',
        oldMemory: 'Armory stocking is active.',
        turns: [
            {
                role: 'system',
                content: 'Chest at 8,70,-2 is blocked by cobblestone.'
            },
            {
                role: 'assistant',
                content: 'takeFromChest("raw_iron",1) timed out waiting for windowOpen twice.'
            },
            {
                role: 'system',
                content: 'After breaking the cobblestone in front, useOn("hand","chest") opened it and raw iron transfer succeeded.'
            },
            {
                role: 'assistant',
                content: 'Armory now has the transferred raw iron.'
            }
        ],
        facts: [
            /(armory|chest)/i,
            /(8\s*,\s*70\s*,\s*-2|chest)/i,
            /(windowOpen|times? out|timeout)/i,
            /(raw iron|raw_iron)/i
        ],
        policies: [
            /(clear|open|break|remove).{0,45}(access|cobblestone|block|obstruction)/i,
            /(before|then|after).{0,50}(transfer|interact|open|retry)/i
        ],
        incidentalCoordinates: []
    },
    {
        id: 'multi-room-layout',
        oldMemory: 'Epic megabase room layout is being coordinated.',
        turns: [
            {
                role: 'system',
                content: 'Durable hub anchor is -12,75,-23.'
            },
            {
                role: 'assistant',
                content: 'Room anchors: chess -12,75,-23; vault -24,75,-23; trophy 0,75,-23; wild creative -12,75,-35.'
            },
            {
                role: 'system',
                content: 'A blocked core corridor prevented builders from reaching the trophy and creative rooms.'
            },
            {
                role: 'assistant',
                content: 'After the corridor was cleared, builders reached every assigned room. Trophy hall still needs oak, cobblestone, and four torches.'
            }
        ],
        facts: [
            /chess/i,
            /vault/i,
            /trophy/i,
            /(wild|creative)/i,
            /(oak|cobblestone|torch)/i
        ],
        policies: [
            /(keep|preserve|clear).{0,40}(route|room|assignment|core|corridor)/i
        ],
        incidentalCoordinates: []
    },
    {
        id: 'adaptive-search-radius',
        oldMemory: 'Oak logs are needed for construction.',
        turns: [
            {
                role: 'assistant',
                content: 'searchForBlock("oak_log",20) found nothing.'
            },
            {
                role: 'system',
                content: 'A second search within 20 blocks also found no oak logs.'
            },
            {
                role: 'assistant',
                content: 'searchForBlock("oak_log",96) found oak at 44,72,-18; collection succeeded.'
            },
            {
                role: 'system',
                content: 'Construction now has eight oak logs.'
            }
        ],
        facts: [
            /oak/i,
            /(44\s*,\s*72\s*,\s*-18|source)/i,
            /(eight|8)/i
        ],
        policies: [
            /(increase|expand|widen|larger|farther|up to|beyond).{0,45}(radius|range|search|blocks|96)/i,
            /((do not|don'?t|never|avoid).{0,45}(repeat|retry|same radius|20)|(none|not|no).{0,50}(20|nearby).{0,80}(search|expand|96))/i
        ],
        incidentalCoordinates: []
    },
    {
        id: 'tool-upgrade',
        oldMemory: 'Stone is needed for the base.',
        turns: [
            {
                role: 'assistant',
                content: 'Tried mining stone with a wooden shovel; block did not break.'
            },
            {
                role: 'system',
                content: 'A second stone mining attempt with the shovel failed.'
            },
            {
                role: 'assistant',
                content: 'Crafted and equipped a wooden pickaxe, then collected twelve stone successfully.'
            },
            {
                role: 'system',
                content: 'Base task still needs the collected stone delivered to the shared cache.'
            }
        ],
        facts: [
            /stone/i,
            /(wooden pickaxe|pickaxe)/i,
            /(twelve|12)/i,
            /(shared cache|deliver)/i
        ],
        policies: [
            /(correct|proper|suitable|required|use|need).{0,40}(a )?(wooden )?(tool|pickaxe)/i,
            /(craft|equip|upgrade).{0,40}(tool|pickaxe)/i
        ],
        incidentalCoordinates: []
    }
];

const CODING_FIXTURES = [
    {
        id: 'reroute-flood',
        task: [
            'The direct hall path to -22,62,-33 failed twice because water blocks it.',
            'A dry ledge is beneath the bot. Write code to make forward progress without retrying the same failed path.'
        ].join(' '),
        requirements: [
            /(placeBlock|bridge|scaffold)/i,
            /(height|elevat|offset|above|start)/i
        ],
        forbidden: []
    },
    {
        id: 'parameterized-wall',
        task: 'Build a wall 6 blocks wide and 4 blocks tall at the bot current position using cobblestone.',
        requirements: [
            /const\s+\w*(width|height)\w*\s*=\s*(6|4)/i,
            /for\s*\(/,
            /skills\.placeBlock/
        ],
        forbidden: []
    },
    {
        id: 'nearest-log',
        task: 'Find the nearest oak log within 64 blocks, navigate to it, and collect 8 oak logs.',
        requirements: [
            /(getNearestBlock|searchForBlock|collectBlock)/,
            /skills\.(goToPosition|collectBlock)/,
            /(const|let)\s+\w+/
        ],
        forbidden: [
            /goToPosition\s*\(\s*bot\s*,\s*-?\d+\s*,\s*-?\d+\s*,\s*-?\d+/
        ]
    },
    {
        id: 'tool-strategy',
        task: [
            'Mining stone failed because the bot has no suitable pickaxe.',
            'Write code that changes strategy rather than simply retrying the same mining call.'
        ].join(' '),
        requirements: [
            /(craft|tool|pickaxe)/i,
            /(skills\.craftRecipe|skills\.collectBlock|skills\.equip)/i
        ],
        forbidden: []
    }
];

function parseArgs(argv) {
    const options = {
        baseline: DEFAULT_BASELINE,
        treatment: DEFAULT_TREATMENT,
        model: DEFAULT_MODEL,
        repetitions: 2,
        output: 'results/bennett-prompt-eval.json',
        rescore: null
    };
    for (const arg of argv) {
        const [name, value] = arg.split('=');
        if (name === '--baseline') options.baseline = value;
        if (name === '--treatment') options.treatment = value;
        if (name === '--model') options.model = value;
        if (name === '--repetitions') options.repetitions = Number(value);
        if (name === '--output') options.output = value;
        if (name === '--rescore') options.rescore = value;
    }
    return options;
}

function readProfile(ref) {
    if (ref === 'WORKTREE') {
        return JSON.parse(
            readFileSync('./profiles/defaults/_default.json', 'utf8')
        );
    }
    const raw = execFileSync(
        'git',
        ['show', `${ref}:profiles/defaults/_default.json`],
        { encoding: 'utf8' }
    );
    return JSON.parse(raw);
}

function formatTurns(turns) {
    return turns
        .map(turn => `${turn.role.toUpperCase()}: ${turn.content}`)
        .join('\n');
}

function memoryPrompt(profile, fixture) {
    return profile.saving_memory
        .replaceAll('$NAME', 'eval_bot')
        .replaceAll('$MEMORY', fixture.oldMemory)
        .replaceAll('$TO_SUMMARIZE', formatTurns(fixture.turns))
        .replaceAll('$SELF_PROMPT', '');
}

function turnsToRetrievalText(turns) {
    return turns
        .filter(turn => turn.role !== 'assistant')
        .map(turn => turn.content.substring(turn.content.indexOf(':') + 1).trim())
        .join('\n')
        .trim();
}

function formatExamples(examples, task, selectNum = 2) {
    const query = turnsToRetrievalText([{ role: 'user', content: task }]);
    return examples
        .map((example, index) => ({
            example,
            index,
            score: wordOverlapScore(query, turnsToRetrievalText(example))
        }))
        .sort((left, right) => right.score - left.score || left.index - right.index)
        .slice(0, selectNum)
        .map(candidate => candidate.example)
        .map(example => formatTurns(example))
        .join('\n\n');
}

function codingPrompt(profile, fixture) {
    return profile.coding
        .replaceAll('$NAME', 'eval_bot')
        .replaceAll('$EXAMPLES', formatExamples(profile.coding_examples || [], fixture.task))
        .replaceAll('$SELF_PROMPT', '')
        .replaceAll('$MEMORY', 'Prefer reusable strategies; do not repeat known failures.')
        .replaceAll('$STATS', 'Position is available from bot.entity.position.')
        .replaceAll('$INVENTORY', 'Cobblestone and basic crafting materials may be available.')
        .replaceAll('$CODE_DOCS', [
            'skills.placeBlock(bot, blockType, x, y, z)',
            'skills.goToPosition(bot, x, y, z)',
            'skills.collectBlock(bot, blockType, count)',
            'skills.craftRecipe(bot, itemName, count)',
            "world.getNearestBlock(bot, blockName, maxDistance)"
        ].join('\n'))
        .concat(`\nUSER TASK:\n${fixture.task}`);
}

function countMatches(text, patterns) {
    return patterns.filter(pattern => pattern.test(text)).length;
}

function coordinateCount(text) {
    return (text.match(/-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?/g) || []).length;
}

function scoreMemory(fixture, output) {
    const factRecall = countMatches(output, fixture.facts) / fixture.facts.length;
    const policyRecall = countMatches(output, fixture.policies) / fixture.policies.length;
    const incidentalCoordinates = fixture.incidentalCoordinates.filter(coord =>
        output.replaceAll(' ', '').includes(coord)
    ).length;
    return {
        chars: output.length,
        withinLimit: output.length <= 500,
        factRecall,
        policyRecall,
        coordinates: coordinateCount(output),
        incidentalCoordinates
    };
}

function extractCode(output) {
    const match = output.match(/```(?:js|javascript)?\s*([\s\S]*?)```/i);
    return match ? match[1].trim() : '';
}

function scoreCoding(fixture, output) {
    const code = extractCode(output);
    const requirements = countMatches(code, fixture.requirements) / fixture.requirements.length;
    let forbidden = countMatches(code, fixture.forbidden);
    if (
        fixture.id === 'reroute-flood' &&
        /-22\s*,\s*62\s*,\s*-33/.test(code) &&
        !/skills\.placeBlock/.test(code)
    ) {
        forbidden++;
    }
    return {
        hasCodeBlock: code.length > 0,
        hasAwait: /\bawait\b/.test(code),
        noImports: !/\b(import|require)\b/.test(code),
        requirementRecall: requirements,
        forbiddenMatches: forbidden,
        chars: code.length
    };
}

function average(rows, getter) {
    return rows.reduce((sum, row) => sum + getter(row), 0) / rows.length;
}

function aggregateMemory(rows) {
    return {
        factRecall: average(rows, row => row.metrics.factRecall),
        policyRecall: average(rows, row => row.metrics.policyRecall),
        coordinateCount: average(rows, row => row.metrics.coordinates),
        incidentalCoordinates: average(rows, row => row.metrics.incidentalCoordinates),
        lengthCompliance: average(rows, row => Number(row.metrics.withinLimit)),
        averageChars: average(rows, row => row.metrics.chars)
    };
}

function aggregateCoding(rows) {
    return {
        validCode: average(rows, row =>
            Number(row.metrics.hasCodeBlock && row.metrics.hasAwait && row.metrics.noImports)
        ),
        requirementRecall: average(rows, row => row.metrics.requirementRecall),
        forbiddenMatches: average(rows, row => row.metrics.forbiddenMatches),
        averageChars: average(rows, row => row.metrics.chars)
    };
}

function compare(baseline, treatment) {
    const gates = {
        memoryPolicyGain: treatment.memory.policyRecall - baseline.memory.policyRecall >= 0.15,
        memoryFactNonRegression: treatment.memory.factRecall >= baseline.memory.factRecall - 0.05,
        memoryLengthCompliance: treatment.memory.lengthCompliance >= 0.95,
        coordinateNoiseNonRegression:
            treatment.memory.incidentalCoordinates <= baseline.memory.incidentalCoordinates,
        codingRequirementGain:
            treatment.coding.requirementRecall >= baseline.coding.requirementRecall + 0.10,
        codingValidityNonRegression:
            treatment.coding.validCode >= baseline.coding.validCode,
        codingForbiddenNonRegression:
            treatment.coding.forbiddenMatches <= baseline.coding.forbiddenMatches
    };
    const passed = Object.values(gates).filter(Boolean).length;
    return {
        gates,
        passed,
        total: Object.keys(gates).length,
        verdict: passed === Object.keys(gates).length ? 'VERIFIED' : 'NOT VERIFIED'
    };
}

async function runCondition(label, profile, modelName, repetitions) {
    const model = new CursorSDK(modelName, null, {
        reasoning: 'none',
        max_sends_per_agent: 4
    });
    const memory = [];
    const coding = [];

    for (let repetition = 1; repetition <= repetitions; repetition++) {
        for (const fixture of MEMORY_FIXTURES) {
            const output = (await model.sendRequest([], memoryPrompt(profile, fixture))).trim();
            memory.push({
                condition: label,
                repetition,
                fixture: fixture.id,
                output,
                metrics: scoreMemory(fixture, output)
            });
        }
        for (const fixture of CODING_FIXTURES) {
            const output = (await model.sendRequest([], codingPrompt(profile, fixture), '\0')).trim();
            coding.push({
                condition: label,
                repetition,
                fixture: fixture.id,
                output,
                metrics: scoreCoding(fixture, output)
            });
        }
    }
    return { memory, coding };
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (!Number.isInteger(options.repetitions) || options.repetitions < 1) {
        throw new Error('--repetitions must be a positive integer');
    }

    const baselineProfile = readProfile(options.baseline);
    const treatmentProfile = readProfile(options.treatment);
    let baselineRows;
    let treatmentRows;
    if (options.rescore) {
        const prior = JSON.parse(readFileSync(options.rescore, 'utf8'));
        const memoryById = new Map(MEMORY_FIXTURES.map(fixture => [fixture.id, fixture]));
        const codingById = new Map(CODING_FIXTURES.map(fixture => [fixture.id, fixture]));
        const rescore = condition => ({
            memory: prior.rows[condition].memory.map(row => ({
                ...row,
                metrics: scoreMemory(memoryById.get(row.fixture), row.output)
            })),
            coding: prior.rows[condition].coding.map(row => ({
                ...row,
                metrics: scoreCoding(codingById.get(row.fixture), row.output)
            }))
        });
        baselineRows = rescore('baseline');
        treatmentRows = rescore('treatment');
    } else {
        baselineRows = await runCondition(
            'baseline',
            baselineProfile,
            options.model,
            options.repetitions
        );
        treatmentRows = await runCondition(
            'treatment',
            treatmentProfile,
            options.model,
            options.repetitions
        );
    }
    const baseline = {
        memory: aggregateMemory(baselineRows.memory),
        coding: aggregateCoding(baselineRows.coding)
    };
    const treatment = {
        memory: aggregateMemory(treatmentRows.memory),
        coding: aggregateCoding(treatmentRows.coding)
    };
    const comparison = compare(baseline, treatment);
    const report = {
        generatedAt: new Date().toISOString(),
        options,
        thresholds: {
            memoryPolicyGain: 0.15,
            memoryFactRegressionTolerance: 0.05,
            memoryLengthCompliance: 0.95,
            codingRequirementGain: 0.10
        },
        fixtureCounts: {
            memory: MEMORY_FIXTURES.length,
            coding: CODING_FIXTURES.length
        },
        promptChars: {
            baseline: {
                savingMemory: baselineProfile.saving_memory.length,
                codingInstructions: baselineProfile.coding.length
            },
            treatment: {
                savingMemory: treatmentProfile.saving_memory.length,
                codingInstructions: treatmentProfile.coding.length
            }
        },
        baseline,
        treatment,
        comparison,
        rows: {
            baseline: baselineRows,
            treatment: treatmentRows
        }
    };

    const outputPath = path.resolve(options.output);
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ baseline, treatment, comparison, outputPath }, null, 2));
    process.exitCode = comparison.verdict === 'VERIFIED' ? 0 : 1;
}

await main();
