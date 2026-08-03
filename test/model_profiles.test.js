import assert from 'node:assert/strict';
import test from 'node:test';

import {
    GPT_56_FAMILIES,
    REASONING_PRESETS,
    getGpt56Profiles,
} from '../src/mindcraft/model_profiles.js';

test('generates every GPT 5.6 family and reasoning preset combination', () => {
    const profiles = getGpt56Profiles();

    assert.equal(
        profiles.length,
        GPT_56_FAMILIES.length * REASONING_PRESETS.length
    );
    assert.equal(new Set(profiles.map(profile => profile.id)).size, profiles.length);
    assert.equal(new Set(profiles.map(profile => profile.name)).size, profiles.length);

    for (const family of GPT_56_FAMILIES) {
        for (const preset of REASONING_PRESETS) {
            const profile = profiles.find(candidate =>
                candidate.profile.model.model === family.model &&
                candidate.profile.model.params.reasoning === preset.effort
            );

            assert.ok(profile, `missing ${family.id} ${preset.id}`);
            assert.equal(profile.provider, 'cursor');
            assert.equal(profile.profile.model.api, 'cursor');
            assert.match(profile.model, new RegExp(`${preset.effort}$`));
            assert.ok(profile.name.length <= 16, `${profile.name} exceeds Minecraft's name limit`);
        }
    }
});

test('returns fresh profiles that callers can safely customize', () => {
    const first = getGpt56Profiles();
    first[0].profile.name = 'changed';
    first[0].profile.model.params.reasoning = 'changed';

    const second = getGpt56Profiles();
    assert.equal(second[0].profile.name, 'terra_instant');
    assert.equal(second[0].profile.model.params.reasoning, 'none');
});
