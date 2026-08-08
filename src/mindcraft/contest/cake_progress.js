/** Live team progress toward crafting a cake in First Cake (`cake_race`). */

export const DEFAULT_CAKE_INGREDIENTS = Object.freeze({
    milk_bucket: 3,
    sugar: 2,
    egg: 1,
    wheat: 3,
});

export const CAKE_INGREDIENT_LABELS = Object.freeze({
    milk_bucket: 'Milk',
    sugar: 'Sugar',
    egg: 'Egg',
    wheat: 'Wheat',
    cake: 'Cake',
});

/**
 * Map raw inventory item ids onto cake-recipe slots.
 * Sugar cane crafts 1:1 into sugar, so it counts toward the sugar requirement.
 */
export function cakeRelevantCounts(counts = {}) {
    const milk = Math.max(0, Number(counts.milk_bucket) || 0);
    const sugar = Math.max(0, Number(counts.sugar) || 0)
        + Math.max(0, Number(counts.sugar_cane) || 0);
    const egg = Math.max(0, Number(counts.egg) || 0);
    const wheat = Math.max(0, Number(counts.wheat) || 0);
    const cake = Math.max(0, Number(counts.cake) || 0);
    return { milk_bucket: milk, sugar, egg, wheat, cake };
}

function emptySlots(ingredients) {
    return Object.fromEntries(Object.keys(ingredients).map(item => [item, 0]));
}

function addSlots(target, source) {
    for (const item of Object.keys(target)) {
        target[item] += Math.max(0, Number(source[item]) || 0);
    }
    return target;
}

function clampSlots(have, ingredients) {
    return Object.fromEntries(
        Object.entries(ingredients).map(([item, need]) => [
            item,
            Math.min(Math.max(0, Number(have[item]) || 0), need),
        ])
    );
}

function progressScore(have, ingredients, hasCake) {
    if (hasCake) {
        return Object.values(ingredients).reduce((total, need) => total + need, 0) + 1;
    }
    return Object.entries(ingredients).reduce(
        (total, [item, need]) => total + Math.min(Math.max(0, Number(have[item]) || 0), need),
        0
    );
}

function neededTotal(ingredients) {
    return Object.values(ingredients).reduce((total, need) => total + need, 0);
}

/**
 * Aggregate each team's cake ingredients from per-bot inventory counts.
 *
 * Inventories may be raw item maps (`{ wheat: 2 }`) or already mapped via
 * `cakeRelevantCounts`. Team totals sum every member; progress bars clamp to
 * the recipe so split inventories still show true readiness.
 */
export function measureCakeRaceProgress({
    inventories = {},
    teamNames = [],
    teamByParticipant = {},
    participantIds = [],
    ingredients = DEFAULT_CAKE_INGREDIENTS,
    winItem = 'cake',
    reportingParticipants = null,
} = {}) {
    if (!Array.isArray(teamNames) || teamNames.length === 0) {
        return { teamResults: [], neededTotal: neededTotal(ingredients) };
    }

    const recipe = { ...DEFAULT_CAKE_INGREDIENTS, ...ingredients };
    delete recipe.cake;
    const ids = participantIds.length
        ? participantIds
        : Object.keys(teamByParticipant);

    const teamResults = teamNames.map(teamName => {
        const members = ids.filter(id => teamByParticipant[id] === teamName);
        const have = emptySlots(recipe);
        let cakes = 0;
        const memberBreakdown = [];

        for (const participantId of members) {
            const mapped = cakeRelevantCounts(inventories[participantId] || {});
            const memberHave = emptySlots(recipe);
            addSlots(memberHave, mapped);
            cakes += mapped.cake || 0;
            addSlots(have, memberHave);
            memberBreakdown.push({
                participantId,
                have: memberHave,
                cake: mapped.cake || 0,
                reporting: reportingParticipants
                    ? reportingParticipants.has(participantId)
                    : inventories[participantId] != null,
            });
        }

        const clamped = clampSlots(have, recipe);
        const hasCake = cakes > 0 || Boolean(
            members.some(id => (inventories[id] || {})[winItem])
        );
        const gathered = progressScore(have, recipe, hasCake);
        const need = neededTotal(recipe);
        const reporting = memberBreakdown.some(member => member.reporting);

        return {
            teamName,
            members,
            have,
            clamped,
            cakes,
            hasCake,
            gathered,
            needed: need,
            complete: hasCake || Object.entries(recipe).every(
                ([item, needCount]) => (have[item] || 0) >= needCount
            ),
            score: gathered,
            reporting,
            membersDetail: memberBreakdown,
            ingredients: Object.entries(recipe).map(([item, needCount]) => ({
                item,
                label: CAKE_INGREDIENT_LABELS[item] || item,
                have: have[item] || 0,
                need: needCount,
                ready: (have[item] || 0) >= needCount,
            })),
        };
    }).sort((left, right) =>
        right.gathered - left.gathered
        || Number(right.hasCake) - Number(left.hasCake)
        || teamNames.indexOf(left.teamName) - teamNames.indexOf(right.teamName)
    );

    let previousScore = null;
    let previousRank = 0;
    const ranked = teamResults.map((result, index) => {
        const rank = result.gathered === previousScore ? previousRank : index + 1;
        previousScore = result.gathered;
        previousRank = rank;
        return { ...result, rank };
    });

    return {
        teamResults: ranked,
        neededTotal: neededTotal(recipe),
        ingredients: recipe,
    };
}

export function formatCakeTeamProgress(team, { compact = false } = {}) {
    if (!team) return '';
    if (team.hasCake) return compact ? 'CAKE!' : 'cake crafted';
    const parts = (team.ingredients || []).map(slot => {
        const short = slot.item === 'milk_bucket' ? 'M'
            : slot.item === 'sugar' ? 'S'
                : slot.item === 'egg' ? 'E'
                    : slot.item === 'wheat' ? 'W'
                        : slot.item[0]?.toUpperCase() || '?';
        return compact
            ? `${short}${Math.min(slot.have, slot.need)}/${slot.need}`
            : `${slot.label} ${Math.min(slot.have, slot.need)}/${slot.need}`;
    });
    return compact
        ? `${team.gathered}/${team.needed} (${parts.join(' ')})`
        : `${team.gathered}/${team.needed} · ${parts.join(', ')}`;
}

export function formatCakeRaceBossbarSummary(teamResults = []) {
    if (!teamResults.length) return 'No progress yet';
    return teamResults
        .map(team => `${team.teamName} ${formatCakeTeamProgress(team, { compact: true })}`)
        .join(' · ');
}
