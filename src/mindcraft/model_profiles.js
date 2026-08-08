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
 * Cursor models offered as bot profiles. `param` is the effort-style parameter the
 * model accepts (`reasoning` or `effort`) and `presets` lists only the REASONING_PRESETS
 * values it actually supports; both come from `Cursor.models.list()`, so a model that
 * exposes no effort dial (`param: null`) yields a single profile.
 *
 * Non-Cursor families set `api` / `provider` (e.g. OpenRouter for Muse Spark, which
 * Cursor does not ship yet). Default api/provider is `cursor`.
 *
 * Profile ids are the model id with dots/slashes flattened, plus the preset id. Existing
 * ids (`gpt-5-6-terra-balanced`) are referenced by contest presets and saved colonies, so
 * changing a family's `id` or `model` renames its profile and orphans those references.
 *
 * List order drives the profile dropdown and the roster picker's fallback, so families
 * are cheapest and quickest first: whatever a game grabs without being told is a fast
 * chat model, not `sol` or `opus` at twenty times the price.
 */
export const CURSOR_FAMILIES = [
    { id: 'composer', model: 'composer-2.5', param: null, presets: [] },
    { id: 'grok', model: 'grok-4.5', param: 'effort', presets: ['fast', 'balanced', 'thorough'] },
    { id: 'luna', model: 'gpt-5.6-luna', param: 'reasoning', presets: ALL_PRESETS },
    { id: 'fable', model: 'claude-fable-5', param: 'effort', presets: ['fast', 'balanced', 'thorough', 'deep', 'max'] },
    // `gemini_pro` rather than `gemini`: profiles/gemini.json already claims that bot name.
    // Cursor's newest Gemini is 3.6 Flash (3.1 Pro remains available but is older).
    { id: 'gemini_pro', model: 'gemini-3.6-flash', param: null, presets: [] },
    { id: 'kimi', model: 'kimi-k3', param: 'reasoning', presets: ['fast', 'thorough', 'max'] },
    { id: 'terra', model: 'gpt-5.6-terra', param: 'reasoning', presets: ALL_PRESETS },
    // Muse Spark is not on Cursor yet; OpenRouter serves meta/muse-spark-1.2 today.
    {
        id: 'muse',
        model: 'meta/muse-spark-1.2',
        api: 'openrouter',
        provider: 'openrouter',
        param: null,
        presets: [],
    },
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

function buildProfile(family, preset) {
    const name = preset ? `${family.id}_${preset.id}` : family.id;
    const api = family.api || 'cursor';
    const provider = family.provider || 'cursor';
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
                ...(preset ? { params: { [family.param]: preset.effort } } : {}),
            },
        },
    };
}

function findPreset(family, id) {
    const preset = REASONING_PRESETS.find(candidate => candidate.id === id);
    if (!preset) {
        throw new Error(`Unknown reasoning preset '${id}' for cursor model ${family.model}`);
    }
    return preset;
}

function modelSlug(model) {
    return model.replaceAll('/', '-').replaceAll('.', '-');
}
