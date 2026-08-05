import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, writeFileSync } from 'fs';
import { createCanvas } from 'canvas';

// Generates deterministic 64x64 Minecraft skins so every bot is visually unique
// and its LLM model is identifiable at a glance:
//  - a solid model-family color band wraps the chest and both arms, with the
//    model's short word (MINI/SOL/TERA/LUNA) spelled out across the front
//  - the model provider's logo is drawn on the back of the torso
//  - hair, headband, pants, and skin tone are derived from the bot's name

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SKINS_DIR = path.resolve(__dirname, '../../skins');
// The MC container bind-mounts SKINS_DIR at /skins, and the mindserver serves
// it at /skins, so one path string works for both FabricTailor and the web UI.
export const SKINS_MOUNT = '/skins';

const MODEL_FAMILIES = [
    { match: /mini/i,  key: 'mini',  word: 'MINI', color: '#2fd3c9', mcColor: 'aqua' },
    { match: /sol/i,   key: 'sol',   word: 'SOL',  color: '#ffb32b', mcColor: 'gold' },
    { match: /terra/i, key: 'terra', word: 'TERA', color: '#5fc953', mcColor: 'green' },
    { match: /luna/i,  key: 'luna',  word: 'LUNA', color: '#c77dff', mcColor: 'light_purple' },
];

const PROVIDER_LOGOS = {
    // 8x8 approximation of the OpenAI hexagonal knot, used for gpt-* models.
    openai: [
        '..####..',
        '.#....#.',
        '#..##..#',
        '#.#..#.#',
        '#.#..#.#',
        '#..##..#',
        '.#....#.',
        '..####..',
    ],
    // Generic fallback: a diamond.
    generic: [
        '...##...',
        '..####..',
        '.######.',
        '########',
        '########',
        '.######.',
        '..####..',
        '...##...',
    ],
};

// 3x5 pixel font ('I' is 1px wide so 4-letter words fit across the chest).
const FONT = {
    A: ['.#.', '#.#', '###', '#.#', '#.#'],
    E: ['###', '#..', '##.', '#..', '###'],
    G: ['.##', '#..', '#.#', '#.#', '.##'],
    I: ['#', '#', '#', '#', '#'],
    L: ['#..', '#..', '#..', '#..', '###'],
    M: ['#.#', '###', '###', '#.#', '#.#'],
    N: ['#.#', '###', '###', '###', '#.#'],
    O: ['.#.', '#.#', '#.#', '#.#', '.#.'],
    P: ['##.', '#.#', '##.', '#..', '#..'],
    R: ['##.', '#.#', '##.', '#.#', '#.#'],
    S: ['.##', '#..', '.#.', '..#', '##.'],
    T: ['###', '.#.', '.#.', '.#.', '.#.'],
    U: ['#.#', '#.#', '#.#', '#.#', '###'],
};

const SKIN_TONES = ['#f2c79c', '#e6ac73', '#c98d5a', '#a06a3d', '#8d5524', '#ffd9b3'];
const HAIR_COLORS = ['#3b2f2f', '#111111', '#5a3825', '#7a4a12', '#b5651d', '#e0c060', '#9e9e9e', '#274472'];

export function hashName(name) {
    let h = 2166136261;
    for (let i = 0; i < name.length; i++) {
        h ^= name.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

function modelString(model) {
    if (!model) return 'unknown';
    if (typeof model === 'string') return model;
    return model.model || 'unknown';
}

export function modelInfo(model) {
    const label = modelString(model);
    const family = MODEL_FAMILIES.find(f => f.match.test(label));
    const word = family ? family.word : label.replace(/[^a-z0-9]/gi, '').slice(0, 4).toUpperCase();
    return {
        label,
        key: family?.key || 'other',
        word,
        color: family?.color || '#e8e8e8',
        mcColor: family?.mcColor || 'white',
        logo: /gpt/i.test(label) ? 'openai' : 'generic',
        teamId: 'model_' + (family?.key || label.replace(/[^a-z0-9]/gi, '').slice(0, 12).toLowerCase() || 'other'),
    };
}

function shade(hex, factor) {
    const n = parseInt(hex.slice(1), 16);
    const r = Math.min(255, Math.max(0, Math.round(((n >> 16) & 255) * factor)));
    const g = Math.min(255, Math.max(0, Math.round(((n >> 8) & 255) * factor)));
    const b = Math.min(255, Math.max(0, Math.round((n & 255) * factor)));
    return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

function luminance(hex) {
    const n = parseInt(hex.slice(1), 16);
    return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
}

export function renderSkin(name, model) {
    const info = modelInfo(model);
    const seed = hashName(name);
    const canvas = createCanvas(64, 64);
    const ctx = canvas.getContext('2d');

    const skinTone = SKIN_TONES[seed % SKIN_TONES.length];
    const hair = HAIR_COLORS[(seed >>> 3) % HAIR_COLORS.length];
    const accentHue = seed % 360;
    const accent = `hsl(${accentHue}, 70%, 55%)`;
    const pants = `hsl(${(accentHue + 40) % 360}, 45%, 38%)`;
    const shirt = '#23262e';
    const boots = '#17171c';
    const bandText = luminance(info.color) > 140 ? '#101014' : '#ffffff';

    let noiseState = seed;
    const noise = () => {
        noiseState = Math.imul(noiseState ^ (noiseState >>> 15), 2246822507) >>> 0;
        return (noiseState % 100) / 100;
    };
    const px = (x, y, color) => { ctx.fillStyle = color; ctx.fillRect(x, y, 1, 1); };
    // shade() needs hex; resolve hsl() colors once via a tiny canvas trick.
    const rgbCache = {};
    const rgbOf = (color) => {
        if (color.startsWith('#')) return color;
        if (!rgbCache[color]) {
            ctx.fillStyle = color;
            rgbCache[color] = ctx.fillStyle; // canvas normalizes to #rrggbb
        }
        return rgbCache[color];
    };
    const box = (x, y, w, h, color, variation = 0) => {
        for (let i = 0; i < w; i++) {
            for (let j = 0; j < h; j++) {
                const f = variation ? 1 - variation / 2 + noise() * variation : 1;
                px(x + i, y + j, variation ? shade(rgbOf(color), f) : color);
            }
        }
    };

    const drawBitmap = (bitmap, x, y, color) => {
        bitmap.forEach((row, j) => {
            for (let i = 0; i < row.length; i++) {
                if (row[i] === '#') px(x + i, y + j, color);
            }
        });
    };
    const drawWordRow = (letters, x, width, y, color) => {
        const glyphs = letters.split('').map(c => FONT[c]).filter(Boolean);
        const total = glyphs.reduce((s, g) => s + g[0].length, 0) + Math.max(0, glyphs.length - 1);
        let cx = x + Math.max(0, Math.floor((width - total) / 2));
        for (const g of glyphs) {
            drawBitmap(g, cx, y, color);
            cx += g[0].length + 1;
        }
    };

    // --- Head (all six faces), hair on top + upper rim ---
    const headFaces = [[8, 8], [0, 8], [16, 8], [24, 8]]; // front, right, left, back
    box(8, 0, 8, 8, hair, 0.15);            // top = hair
    box(16, 0, 8, 8, skinTone, 0.06);       // bottom
    for (const [hx, hy] of headFaces) {
        box(hx, hy, 8, 8, skinTone, 0.06);
        box(hx, hy, 8, 2, hair, 0.15);      // hairline
    }
    // Face details (front face at 8,8): eyes with family-color pupils.
    px(9, 12, '#ffffff'); px(10, 12, info.color);
    px(13, 12, info.color); px(14, 12, '#ffffff');
    box(11, 14, 2, 1, shade(skinTone, 0.7)); // mouth

    // Hat layer headband: bot-unique accent, wraps all four sides above the eyes.
    for (const hx of [40, 32, 48, 56]) {
        box(hx, 10, 8, 2, accent);
    }
    px(43, 10, info.color); px(44, 10, info.color); // family dot front-center
    px(43, 11, info.color); px(44, 11, info.color);

    // --- Torso ---
    box(20, 20, 8, 12, shirt, 0.08);  // front
    box(32, 20, 8, 12, shirt, 0.08);  // back
    box(16, 20, 4, 12, shirt, 0.08);  // right side
    box(28, 20, 4, 12, shirt, 0.08);  // left side
    box(20, 16, 8, 4, shirt, 0.08);   // top
    box(28, 16, 8, 4, shirt, 0.08);   // bottom

    // Model band (rows 21-25) around front + sides; front carries the word.
    box(20, 21, 8, 5, info.color);
    box(16, 21, 4, 5, info.color);
    box(28, 21, 4, 5, info.color);
    // Word split: first letter on right arm, middle on torso, last on left arm.
    const word = info.word;
    const middle = word.length <= 2 ? word : word.slice(1, -1);
    drawWordRow(middle, 20, 8, 21, bandText);
    // Belt with family-color buckle.
    box(20, 30, 8, 1, boots);
    px(23, 30, info.color); px(24, 30, info.color);

    // Back: provider logo on the shirt.
    drawBitmap(PROVIDER_LOGOS[info.logo], 32, 22, '#ffffff');
    box(32, 31, 8, 1, info.color);

    // --- Arms (right base at 40..55,16..31; left at 32..47,48..63) ---
    const arm = (bx, by, letter) => {
        box(bx + 4, by + 4, 4, 12, shirt, 0.08);   // front
        box(bx + 12, by + 4, 4, 12, shirt, 0.08);  // back
        box(bx, by + 4, 4, 12, shirt, 0.08);       // outer side
        box(bx + 8, by + 4, 4, 12, shirt, 0.08);   // inner side
        box(bx + 4, by, 4, 4, shirt, 0.08);        // top
        box(bx + 8, by, 4, 4, skinTone, 0.06);     // bottom (hand)
        // band wraps the whole arm
        for (const fx of [bx, bx + 4, bx + 8, bx + 12]) box(fx, by + 5, 4, 5, info.color);
        // hands
        for (const fx of [bx, bx + 4, bx + 8, bx + 12]) box(fx, by + 13, 4, 3, skinTone, 0.06);
        if (letter && FONT[letter]) drawWordRow(letter, bx + 4, 4, by + 5, bandText);
    };
    arm(40, 16, word.length >= 3 ? word[0] : null);            // right arm
    arm(32, 48, word.length >= 3 ? word[word.length - 1] : null); // left arm

    // --- Legs (right base at 0..15,16..31; left at 16..31,48..63) ---
    const leg = (bx, by) => {
        for (const fx of [bx, bx + 4, bx + 8, bx + 12]) {
            box(fx, by + 4, 4, 12, pants, 0.08);
            box(fx, by + 12, 4, 1, info.color);   // family stripe
            box(fx, by + 13, 4, 3, boots, 0.08);  // boots
        }
        box(bx + 4, by, 4, 4, pants, 0.08);
        box(bx + 8, by, 4, 4, boots, 0.08);
    };
    leg(0, 16);
    leg(16, 48);

    return canvas;
}

/**
 * Generates (or regenerates) the skin PNG for a bot and returns the profile
 * skin object understood by agent.js and the web UI.
 */
export function ensureSkin(name, model) {
    mkdirSync(SKINS_DIR, { recursive: true });
    const canvas = renderSkin(name, model);
    const file = path.join(SKINS_DIR, `${name}.png`);
    writeFileSync(file, canvas.toBuffer('image/png'));
    const rel = `${SKINS_MOUNT}/${name}.png`;
    return {
        model: 'classic',   // skin variant (classic 4px arms), not the LLM
        file: rel,          // path inside the MC server container (FabricTailor)
        path: rel,          // URL path served by the mindserver (web UI)
        generated: true,
        label: modelInfo(model).label,
    };
}
