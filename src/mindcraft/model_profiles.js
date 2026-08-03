export const GPT_56_FAMILIES = [
    { id: 'terra', model: 'gpt-5.6-terra' },
    { id: 'luna', model: 'gpt-5.6-luna' },
    { id: 'sol', model: 'gpt-5.6-sol' },
];

export const REASONING_PRESETS = [
    { id: 'instant', effort: 'none', label: 'instant / none' },
    { id: 'fast', effort: 'low', label: 'fast / low' },
    { id: 'balanced', effort: 'medium', label: 'balanced / medium' },
    { id: 'thorough', effort: 'high', label: 'thorough / high' },
    { id: 'deep', effort: 'xhigh', label: 'deep / xhigh' },
    { id: 'max', effort: 'max', label: 'slowest / max' },
];

export function getGpt56Profiles() {
    return GPT_56_FAMILIES.flatMap(family =>
        REASONING_PRESETS.map(preset => ({
            id: `gpt-5-6-${family.id}-${preset.id}`,
            name: `${family.id}_${preset.id}`,
            model: `${family.model} · ${preset.label}`,
            provider: 'cursor',
            profile: {
                name: `${family.id}_${preset.id}`,
                model: {
                    api: 'cursor',
                    model: family.model,
                    params: {
                        reasoning: preset.effort,
                    },
                },
            },
        }))
    );
}
