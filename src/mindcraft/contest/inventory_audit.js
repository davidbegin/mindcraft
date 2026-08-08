// Every contestant is supposed to start a game with an identical kit and nothing
// else. These helpers turn the raw `data get entity <name> Inventory` RCON dump
// into a tidy item→count map and diff it against the kit the game hands out, so
// a launch can prove — and, if needed, repair — that everyone began even.

// A kit line is `"<item> <count>"`, e.g. `"iron_pickaxe 1"`. Fold a kit list
// into a plain { item: count } map, summing duplicates.
export function expandKit(kitList = []) {
    const expected = {};
    for (const entry of kitList) {
        const [rawItem, rawCount] = String(entry).trim().split(/\s+/);
        if (!rawItem) continue;
        const item = normalizeItemName(rawItem);
        const count = Number.parseInt(rawCount ?? '1', 10);
        expected[item] = (expected[item] || 0) + (Number.isFinite(count) ? count : 1);
    }
    return expected;
}

// Drop the `minecraft:` namespace and lowercase, so `minecraft:Iron_Pickaxe`,
// `iron_pickaxe` and `Iron_Pickaxe` all compare equal.
export function normalizeItemName(name) {
    return String(name).trim().replace(/^minecraft:/i, '').toLowerCase();
}

// `data get entity <name> Inventory` comes back as, roughly:
//   Billy has the following entity data: [{Slot: 0b, id: "minecraft:iron_pickaxe", Count: 1b}, ...]
// An empty inventory prints `[]`. Sum counts per item id across every slot.
export function parseInventory(rconText) {
    const text = String(rconText ?? '');
    const items = {};
    // Match each `id: "<name>"` paired with the nearest `Count: <n>b` in the
    // same slot object. Component data (`components: {...}`) can sit between
    // them, so allow anything non-greedy up to the Count.
    const slotPattern = /id\s*:\s*"([^"]+)"[\s\S]*?Count\s*:\s*(\d+)b?/g;
    let match;
    while ((match = slotPattern.exec(text)) !== null) {
        const item = normalizeItemName(match[1]);
        const count = Number.parseInt(match[2], 10);
        if (!item || !Number.isFinite(count)) continue;
        items[item] = (items[item] || 0) + count;
    }
    return items;
}

// Compare a parsed inventory to a kit. `extras` are items (or surplus counts)
// the contestant should not have; `missing` are kit items they are short. A
// clean start has neither.
export function diffAgainstKit(actual = {}, kitList = []) {
    const expected = Array.isArray(kitList) ? expandKit(kitList) : { ...kitList };
    const extras = [];
    const missing = [];
    const itemNames = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const item of [...itemNames].sort()) {
        const have = actual[item] || 0;
        const want = expected[item] || 0;
        if (have > want) extras.push({ item, count: have - want });
        else if (have < want) missing.push({ item, count: want - have });
    }
    return {
        matches: extras.length === 0 && missing.length === 0,
        extras,
        missing,
        expected,
        actual: { ...actual },
    };
}
