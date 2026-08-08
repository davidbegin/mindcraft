export const REASONING_PRESETS = [
    { id: 'instant', effort: 'none', label: 'instant / none' },
    { id: 'fast', effort: 'low', label: 'fast / low' },
    { id: 'balanced', effort: 'medium', label: 'balanced / medium' },
    { id: 'thorough', effort: 'high', label: 'thorough / high' },
    { id: 'deep', effort: 'xhigh', label: 'deep / xhigh' },
    { id: 'max', effort: 'max', label: 'slowest / max' },
];

const ALL_PRESETS = REASONING_PRESETS.map(preset => preset.id);

/**
 * Bot model families offered as selectable profiles.
 *
 * `param` is the effort-style parameter the model accepts (`reasoning` or `effort`)
 * and `presets` lists only the REASONING_PRESETS values it actually supports.
 * A model with no effort dial (`param: null`) yields a single profile.
 *
 * `effortMap` remaps preset ids → provider-specific values when they diverge from
 * REASONING_PRESETS (e.g. GPT-5.5's `extra-high`, Gemini Flash's `minimal`).
 *
 * Non-Cursor families set `api` / `provider` (OpenRouter for models Cursor does not
 * ship yet: Muse Spark, DeepSeek V4, Qwen, Mistral, Llama 4). Default is `cursor`.
 *
 * Profile ids are the model id with dots/slashes flattened, plus the preset id.
 * Existing ids are referenced by contest presets and saved colonies, so changing a
 * family's `id` or `model` renames its profile and orphans those references.
 *
 * Bot `name`s must stay ≤16 chars (Minecraft) and must not collide with profiles/*.json.
 *
 * List order drives the profile dropdown and the roster picker's fallback, so families
 * are cheapest and quickest first.
 */
export const CURSOR_FAMILIES = [
    { id: 'composer', model: 'composer-2.5', param: null, presets: [] },
    {
        id: 'dsf',
        model: 'deepseek/deepseek-v4-flash',
        api: 'openrouter',
        provider: 'openrouter',
        param: null,
        presets: [],
    },
    { id: 'grok', model: 'grok-4.5', param: 'effort', presets: ['fast', 'balanced', 'thorough'] },
    { id: 'luna', model: 'gpt-5.6-luna', param: 'reasoning', presets: ALL_PRESETS },
    { id: 'fable', model: 'claude-fable-5', param: 'effort', presets: ['fast', 'balanced', 'thorough', 'deep', 'max'] },
    // `gemini_pro` rather than `gemini`: profiles/gemini.json already claims that bot name.
    { id: 'gemini_pro', model: 'gemini-3.6-flash', param: null, presets: [] },
    { id: 'sonnet', model: 'claude-sonnet-5', param: 'effort', presets: ['fast', 'balanced', 'thorough', 'deep', 'max'] },
    { id: 'kimi', model: 'kimi-k3', param: 'reasoning', presets: ['fast', 'thorough', 'max'] },
    { id: 'terra', model: 'gpt-5.6-terra', param: 'reasoning', presets: ALL_PRESETS },
    {
        id: 'muse',
        model: 'meta/muse-spark-1.2',
        api: 'openrouter',
        provider: 'openrouter',
        param: null,
        presets: [],
    },
    {
        id: 'mav',
        model: 'meta-llama/llama-4-maverick',
        api: 'openrouter',
        provider: 'openrouter',
        param: null,
        presets: [],
    },
    {
        id: 'qwmax',
        model: 'qwen/qwen3.8-max',
        api: 'openrouter',
        provider: 'openrouter',
        param: null,
        presets: [],
    },
    {
        id: 'mist',
        model: 'mistralai/mistral-large-2512',
        api: 'openrouter',
        provider: 'openrouter',
        param: null,
        presets: [],
    },
    {
        id: 'dsv4',
        model: 'deepseek/deepseek-v4-pro',
        api: 'openrouter',
        provider: 'openrouter',
        param: null,
        presets: [],
    },
    // GPT-5.5 uses `extra-high` instead of `xhigh` / `max`.
    {
        id: 'gpt55',
        model: 'gpt-5.5',
        param: 'reasoning',
        presets: ['instant', 'fast', 'balanced', 'thorough', 'deep'],
        effortMap: { deep: 'extra-high' },
    },
    { id: 'gempro', model: 'gemini-3.1-pro', param: null, presets: [] },
    { id: 'glm', model: 'glm-5.2', param: 'reasoning', presets: ['thorough', 'max'] },
    { id: 'sol', model: 'gpt-5.6-sol', param: 'reasoning', presets: ALL_PRESETS },
    { id: 'opus', model: 'claude-opus-5', param: 'effort', presets: ['fast', 'balanced', 'thorough', 'deep', 'max'] },
];

export function getCursorProfiles() {
    return CURSOR_FAMILIES.flatMap(family => {
        if (family.presets.length === 0) {
            return [buildProfile(family, null)];
        }
        return family.presets.map(id => buildProfile(family, findPreset(family, id)));
    });
}

export function effortValue(family, preset) {
    if (!preset) return null;
    if (family.effortMap && Object.prototype.hasOwnProperty.call(family.effortMap, preset.id)) {
        return family.effortMap[preset.id];
    }
    return preset.effort;
}

function buildProfile(family, preset) {
    const name = preset ? `${family.id}_${preset.id}` : family.id;
    const api = family.api || 'cursor';
    const provider = family.provider || 'cursor';
    const effort = effortValue(family, preset);
    return {
        id: preset ? `${modelSlug(family.model)}-${preset.id}` : modelSlug(family.model),
        name,
        model: preset ? `${family.model} · ${preset.label}` : family.model,
        // Rosters group by `family` to spread bots across models rather than filling
        // every slot with one model's effort presets.
        family: family.id,
        provider,
        profile: {
            name,
            model: {
                api,
                model: family.model,
                ...(preset ? { params: { [family.param]: effort } } : {}),
            },
        },
    };
}

function findPreset(family, id) {
    const preset = REASONING_PRESETS.find(candidate => candidate.id === id);
    if (!preset) {
        throw new Error(`Unknown reasoning preset '${id}' for model ${family.model}`);
    }
    return preset;
}

function modelSlug(model) {
    return model.replaceAll('/', '-').replaceAll('.', '-');
}
