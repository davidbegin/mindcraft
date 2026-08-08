import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { createCanvas, Image } from 'canvas';

// Generates deterministic 64x64 Minecraft skins so every bot is visually unique
// and its LLM model is identifiable at a glance:
//  - a solid model-family color band wraps the chest and both arms, with the
//    model's short word (MINI/SOL/OPUS/KIMI/...) spelled out across the front
//  - the model provider's logo is drawn on the back of the torso
//  - hair, headband, pants, and skin tone are derived from the bot's name

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SKINS_DIR = path.resolve(__dirname, '../../skins');
export const LOGOS_DIR = path.resolve(__dirname, '../../assets/model-logos');
// The MC container bind-mounts SKINS_DIR at /skins, and the mindserver serves
// it at /skins, so one path string works for both FabricTailor and the web UI.
export const SKINS_MOUNT = '/skins';

const MODEL_FAMILIES = [
    // Boundary so "gemini" (contains the letters mini) does not paint as MINI.
    { match: /(?:^|[\s./_-])mini(?:$|[\s./_-])/i, key: 'mini', word: 'MINI', color: '#2fd3c9', mcColor: 'aqua' },
    // Match sonnet before sol — otherwise "claude-sonnet-5" paints as SOL.
    { match: /sonnet/i,   key: 'sonnet',   word: 'SONN', color: '#c4a484', mcColor: 'white' },
    { match: /sol/i,      key: 'sol',      word: 'SOL',  color: '#ffb32b', mcColor: 'gold' },
    { match: /terra/i,    key: 'terra',    word: 'TERRA', color: '#5fc953', mcColor: 'green' },
    { match: /luna/i,     key: 'luna',     word: 'LUNA', color: '#c77dff', mcColor: 'light_purple' },
    { match: /composer/i, key: 'composer', word: 'COMP', color: '#cfd3dc', mcColor: 'gray' },
    { match: /opus/i,     key: 'opus',     word: 'OPUS', color: '#d97757', mcColor: 'red' },
    { match: /fable/i,    key: 'fable',    word: 'FABL', color: '#e2b6ff', mcColor: 'dark_purple' },
    { match: /grok/i,     key: 'grok',     word: 'GROK', color: '#1d9bf0', mcColor: 'blue' },
    // Pro before generic gemini so 3.1-pro does not share the Flash chest word.
    { match: /gemini-3\.1-pro|gempro/i, key: 'gempro', word: 'GPRO', color: '#8ab4f8', mcColor: 'dark_gray' },
    { match: /gemini/i,   key: 'gemini',   word: 'GEM',  color: '#4285f4', mcColor: 'dark_aqua' },
    { match: /muse|spark/i, key: 'muse',   word: 'MUSE', color: '#0668e1', mcColor: 'yellow' },
    { match: /maverick|llama-4/i, key: 'mav', word: 'MAV', color: '#0082fb', mcColor: 'dark_red' },
    { match: /kimi/i,     key: 'kimi',     word: 'KIMI', color: '#6f7bff', mcColor: 'dark_blue' },
    { match: /glm/i,      key: 'glm',      word: 'GLM',  color: '#2f9e44', mcColor: 'dark_green' },
    { match: /deepseek-v4-flash/i, key: 'dsf', word: 'DSF', color: '#4d6bfe', mcColor: 'black' },
    { match: /deepseek/i, key: 'dsv4',     word: 'DSK',  color: '#5b6cff', mcColor: 'aqua' },
    { match: /qwen/i,     key: 'qwmax',    word: 'QWEN', color: '#6a00ff', mcColor: 'light_purple' },
    { match: /mistral/i,  key: 'mist',     word: 'MIST', color: '#ff7000', mcColor: 'gold' },
    { match: /gpt-5\.5|gpt55/i, key: 'gpt55', word: 'G55', color: '#10a37f', mcColor: 'green' },
];

// Maps model names (and API providers as a fallback) to the company whose
// logo goes on the skin. Order matters: model-maker patterns come first so
// e.g. a llama model served through groq still shows Meta's logo.
const PROVIDER_PATTERNS = [
    [/gpt|davinci|openai|^o[0-9]/i, 'openai'],
    [/claude|anthropic/i, 'anthropic'],
    [/gemini|gemma|palm|bard/i, 'gemini'],
    [/mistral|mixtral|codestral|ministral/i, 'mistral'],
    [/llama|muse|spark|meta/i, 'meta'],
    [/deepseek/i, 'deepseek'],
    [/qwen|qwq/i, 'qwen'],
    [/grok|xai/i, 'xai'],
    [/groq/i, 'groq'],
    [/huggingface/i, 'huggingface'],
    [/cerebras/i, 'cerebras'],
    [/replicate/i, 'replicate'],
    [/ollama/i, 'ollama'],
    [/cursor|composer/i, 'cursor'],
    [/google/i, 'gemini'],
];

// Hand-drawn 8x8 fallbacks, used when no downloaded logo asset is available.
const FALLBACK_LOGOS = {
    // Approximation of the OpenAI hexagonal knot.
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
    B: ['##.', '#.#', '##.', '#.#', '##.'],
    C: ['.##', '#..', '#..', '#..', '.##'],
    D: ['##.', '#.#', '#.#', '#.#', '##.'],
    E: ['###', '#..', '##.', '#..', '###'],
    F: ['###', '#..', '##.', '#..', '#..'],
    G: ['.##', '#..', '#.#', '#.#', '.##'],
    H: ['#.#', '#.#', '###', '#.#', '#.#'],
    I: ['#', '#', '#', '#', '#'],
    J: ['..#', '..#', '..#', '#.#', '.#.'],
    K: ['#.#', '#.#', '##.', '#.#', '#.#'],
    L: ['#..', '#..', '#..', '#..', '###'],
    M: ['#.#', '###', '###', '#.#', '#.#'],
    N: ['#.#', '###', '###', '###', '#.#'],
    O: ['.#.', '#.#', '#.#', '#.#', '.#.'],
    P: ['##.', '#.#', '##.', '#..', '#..'],
    Q: ['.#.', '#.#', '#.#', '.#.', '..#'],
    R: ['##.', '#.#', '##.', '#.#', '#.#'],
    S: ['.##', '#..', '.#.', '..#', '##.'],
    T: ['###', '.#.', '.#.', '.#.', '.#.'],
    U: ['#.#', '#.#', '#.#', '#.#', '###'],
    V: ['#.#', '#.#', '#.#', '#.#', '.#.'],
    W: ['#.#', '#.#', '###', '###', '#.#'],
    X: ['#.#', '#.#', '.#.', '#.#', '#.#'],
    Y: ['#.#', '#.#', '.#.', '.#.', '.#.'],
    Z: ['###', '..#', '.#.', '#..', '###'],
    0: ['###', '#.#', '#.#', '#.#', '###'],
    1: ['.#.', '##.', '.#.', '.#.', '###'],
    2: ['##.', '..#', '.#.', '#..', '###'],
    3: ['###', '..#', '.##', '..#', '###'],
    4: ['#.#', '#.#', '###', '..#', '..#'],
    5: ['###', '#..', '##.', '..#', '##.'],
    6: ['.##', '#..', '###', '#.#', '###'],
    7: ['###', '..#', '.#.', '.#.', '.#.'],
    8: ['###', '#.#', '###', '#.#', '###'],
    9: ['###', '#.#', '###', '..#', '##.'],
};

// Narrow glyphs let five-letter family names use one letter on each arm and
// three on the torso without abbreviating the model name.
const NARROW_FONT = {
    E: ['##', '#.', '##', '#.', '##'],
    R: ['##', '#.', '##', '##', '#.'],
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

export function detectProvider(model) {
    const label = modelString(model);
    // The model name identifies the maker; the api field is only a fallback
    // (e.g. {api: 'cursor', model: 'gpt-5.4-mini'} is an OpenAI model).
    for (const [pattern, provider] of PROVIDER_PATTERNS) {
        if (pattern.test(label)) return provider;
    }
    const api = typeof model === 'object' && model?.api ? model.api : null;
    if (api) {
        for (const [pattern, provider] of PROVIDER_PATTERNS) {
            if (pattern.test(api)) return provider;
        }
    }
    return null;
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
        provider: detectProvider(model),
        teamId: 'model_' + (family?.key || label.replace(/[^a-z0-9]/gi, '').slice(0, 12).toLowerCase() || 'other'),
    };
}

const logoBitmapCache = new Map();

/**
 * Converts a downloaded official logo PNG (assets/model-logos/<provider>.png)
 * into a pixel-art bitmap of `size`x`size` by sampling its alpha silhouette.
 * Falls back to a hand-drawn glyph when the asset is missing or unusable.
 */
export function logoBitmap(provider, size = 8) {
    const key = `${provider}:${size}`;
    if (logoBitmapCache.has(key)) return logoBitmapCache.get(key);

    let bitmap = null;
    const file = provider ? path.join(LOGOS_DIR, `${provider}.png`) : null;
    if (file && existsSync(file)) {
        try {
            const img = new Image();
            img.src = readFileSync(file); // synchronous decode in node-canvas
            const canvas = createCanvas(size, size);
            const ctx = canvas.getContext('2d');
            ctx.imageSmoothingEnabled = true;
            const scale = Math.min(size / img.width, size / img.height);
            const w = img.width * scale, h = img.height * scale;
            ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
            const data = ctx.getImageData(0, 0, size, size).data;
            const rasterize = (threshold) => {
                const rows = [];
                let set = 0;
                for (let y = 0; y < size; y++) {
                    let row = '';
                    for (let x = 0; x < size; x++) {
                        const on = data[(y * size + x) * 4 + 3] >= threshold;
                        row += on ? '#' : '.';
                        if (on) set++;
                    }
                    rows.push(row);
                }
                return { rows, set };
            };
            // Dense marks (e.g. the OpenAI knot) become blobs at low thresholds
            // and fragments at strict ones. Pick the threshold whose ink
            // coverage is closest to a typical logo mark (~40% of the tile).
            const targetSet = Math.round(size * size * 0.4);
            let best = null;
            for (const threshold of [224, 192, 160, 128, 96, 64, 48]) {
                const candidate = rasterize(threshold);
                if (candidate.set < 4 || candidate.set > size * size - 4) continue;
                if (!best || Math.abs(candidate.set - targetSet) < Math.abs(best.set - targetSet)) {
                    best = candidate;
                }
            }
            if (best) bitmap = best.rows;
        } catch (error) {
            console.warn(`Could not rasterize logo for ${provider}: ${error.message}`);
        }
    }
    if (!bitmap) bitmap = FALLBACK_LOGOS[provider] || FALLBACK_LOGOS.generic;
    logoBitmapCache.set(key, bitmap);
    return bitmap;
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
        let glyphs = letters.split('').map(c => FONT[c]).filter(Boolean);
        let spacing = 1;
        let total = glyphs.reduce((s, g) => s + g[0].length, 0) + Math.max(0, glyphs.length - 1);
        if (total > width) {
            glyphs = letters.split('').map(c => NARROW_FONT[c] || FONT[c]).filter(Boolean);
            total = glyphs.reduce((s, g) => s + g[0].length, 0) + Math.max(0, glyphs.length - 1);
        }
        if (total > width) {
            spacing = 0;
            total = glyphs.reduce((s, g) => s + g[0].length, 0);
        }
        let cx = x + Math.max(0, Math.floor((width - total) / 2));
        for (const g of glyphs) {
            drawBitmap(g, cx, y, color);
            cx += g[0].length + spacing;
        }
    };

    // A box with soft edge shading: lit top edge, shadowed bottom and sides.
    // Gives every body part a rounded, cloth-like read instead of flat fills.
    const panel = (x, y, w, h, color, variation = 0.08) => {
        box(x, y, w, h, color, variation);
        const base = rgbOf(color);
        for (let i = 0; i < w; i++) {
            px(x + i, y, shade(base, 1.10));
            px(x + i, y + h - 1, shade(base, 0.78));
        }
        for (let j = 1; j < h - 1; j++) {
            px(x, y + j, shade(base, 0.90));
            px(x + w - 1, y + j, shade(base, 0.90));
        }
    };

    const hairShadow = shade(hair, 0.72);
    const hairLight = shade(hair, 1.3);
    const familyDark = shade(rgbOf(info.color), 0.72);

    // --- Head (all six faces) ---
    const headFaces = [[8, 8], [0, 8], [16, 8], [24, 8]]; // front, right, left, back
    box(8, 0, 8, 8, hair, 0.15);            // top = hair
    box(16, 0, 8, 8, skinTone, 0.06);       // bottom
    // Highlight streaks across the hair top.
    for (let i = 0; i < 4; i++) px(9 + ((seed >>> i) % 6), 2 + ((seed >>> (i + 4)) % 4), hairLight);
    for (const [hx, hy] of headFaces) {
        panel(hx, hy, 8, 8, skinTone, 0.06);
        box(hx, hy, 8, 2, hair, 0.15);      // hairline
    }
    box(24, 10, 8, 2, hair, 0.15);          // longer hair on the back of the head
    box(24, 12, 8, 1, hairShadow);
    // Fringe style varies per bot: straight, side-swept, or spiky.
    const fringe = (seed >>> 6) % 3;
    if (fringe === 0) {
        box(8, 10, 1, 1, hair); box(15, 10, 1, 1, hair);
    } else if (fringe === 1) {
        box(8, 10, 4, 1, hair); px(8, 11, hairShadow);
    } else {
        for (let i = 8; i < 16; i += 2) px(i, 10, hair);
    }
    // Sideburns where the side faces meet the face.
    box(7, 10, 1, 2, hairShadow); box(16, 10, 1, 2, hairShadow);
    // Face: brows, eyes with family-color pupils, nose, mouth.
    px(9, 11, hairShadow); px(10, 11, hairShadow);
    px(13, 11, hairShadow); px(14, 11, hairShadow);
    px(9, 12, '#ffffff'); px(10, 12, info.color);
    px(13, 12, info.color); px(14, 12, '#ffffff');
    px(11, 13, shade(skinTone, 0.85)); px(12, 13, shade(skinTone, 0.85)); // nose
    const smile = (seed >>> 9) % 2;
    box(11, 14, 2, 1, shade(skinTone, 0.65));
    if (smile) { px(10, 14, shade(skinTone, 0.8)); px(13, 14, shade(skinTone, 0.8)); }

    // Hat layer: bot-unique headband with a family gem, and the provider logo
    // printed on top of the head in the family color.
    for (const hx of [40, 32, 48, 56]) {
        box(hx, 10, 8, 2, accent);
        for (let i = 0; i < 8; i++) px(hx + i, 11, shade(rgbOf(accent), 0.8));
    }
    px(43, 10, info.color); px(44, 10, info.color);
    px(43, 11, familyDark); px(44, 11, familyDark);
    drawBitmap(logoBitmap(info.provider), 40, 0, info.color); // hat top

    // --- Torso ---
    panel(20, 20, 8, 12, shirt);  // front
    panel(32, 20, 8, 12, shirt);  // back
    panel(16, 20, 4, 12, shirt);  // right side
    panel(28, 20, 4, 12, shirt);  // left side
    box(20, 16, 8, 4, shirt, 0.08);   // top
    box(28, 16, 8, 4, shirt, 0.08);   // bottom

    // Model band (rows 20-26) around front + sides; front carries the word
    // (letters occupy rows 21-25 with a lit top edge and shadowed bottom edge).
    const bandFaces = [[20, 8], [16, 4], [28, 4]];
    for (const [bx, bw] of bandFaces) {
        box(bx, 20, bw, 7, info.color);
        for (let i = 0; i < bw; i++) {
            px(bx + i, 20, shade(rgbOf(info.color), 1.15));
            px(bx + i, 26, shade(rgbOf(info.color), 0.8));
        }
    }
    box(20, 27, 8, 1, shade(shirt, 0.7)); // shadow under the band
    // Word split: first letter on right arm, middle on torso, last on left arm.
    const word = info.word;
    const middle = word.length <= 2 ? word : word.slice(1, -1);
    drawWordRow(middle, 20, 8, 21, bandText);
    // Chest pockets.
    for (const pxx of [21, 25]) {
        box(pxx, 28, 2, 2, shade(shirt, 0.8));
        px(pxx, 28, shade(shirt, 1.25)); px(pxx + 1, 28, shade(shirt, 1.25));
    }
    // Belt: family buckle with a metallic glint.
    box(20, 30, 8, 1, boots);
    px(23, 30, info.color); px(24, 30, '#e8d9a0');
    box(20, 31, 8, 1, shade(rgbOf(pants), 0.85));

    // Back: the official provider logo printed dark on a light badge patch,
    // like a jersey emblem — readable from far away.
    const badge = '#e9e9ee';
    box(32, 21, 8, 10, badge, 0.03);
    for (const [cx, cy] of [[32, 21], [39, 21], [32, 30], [39, 30]]) px(cx, cy, shirt); // rounded corners
    for (let i = 0; i < 8; i++) px(32 + i, 30, shade(badge, 0.8));
    drawBitmap(logoBitmap(info.provider), 32, 22, shade(rgbOf(info.color), 0.5));
    box(32, 31, 8, 1, info.color);

    // --- Arms (right base at 40..55,16..31; left at 32..47,48..63) ---
    const arm = (bx, by, letter) => {
        panel(bx + 4, by + 4, 4, 12, shirt);   // front
        panel(bx + 12, by + 4, 4, 12, shirt);  // back
        panel(bx, by + 4, 4, 12, shirt);       // outer side
        panel(bx + 8, by + 4, 4, 12, shirt);   // inner side
        box(bx + 4, by, 4, 4, familyDark, 0.08);   // top = shoulder epaulette
        box(bx + 8, by, 4, 4, skinTone, 0.06);     // bottom (hand)
        // Band wraps the whole arm, shaded like the torso band.
        for (const fx of [bx, bx + 4, bx + 8, bx + 12]) {
            box(fx, by + 4, 4, 7, info.color);
            for (let i = 0; i < 4; i++) {
                px(fx + i, by + 4, shade(rgbOf(info.color), 1.15));
                px(fx + i, by + 10, shade(rgbOf(info.color), 0.8));
            }
            box(fx, by + 12, 4, 1, accent);            // wrist cuff
            box(fx, by + 13, 4, 3, skinTone, 0.06);    // hand
        }
        if (letter && FONT[letter]) drawWordRow(letter, bx + 4, 4, by + 5, bandText);
    };
    arm(40, 16, word.length >= 3 ? word[0] : null);            // right arm
    arm(32, 48, word.length >= 3 ? word[word.length - 1] : null); // left arm

    // --- Legs (right base at 0..15,16..31; left at 16..31,48..63) ---
    const leg = (bx, by) => {
        for (const fx of [bx, bx + 4, bx + 8, bx + 12]) {
            panel(fx, by + 4, 4, 12, pants);
            px(fx, by + 4, accent);               // side seam start
            box(fx, by + 8, 4, 1, shade(rgbOf(pants), 0.85)); // knee crease
            box(fx, by + 12, 4, 1, info.color);   // family stripe
            box(fx, by + 13, 4, 3, boots, 0.08);  // boots
            box(fx, by + 13, 4, 1, shade(boots, 1.7)); // boot rim highlight
        }
        // Side seam down the outer faces.
        for (let j = by + 4; j < by + 12; j++) px(bx, j, shade(rgbOf(accent), 0.8));
        box(bx + 4, by, 4, 4, pants, 0.08);           // top
        box(bx + 8, by, 4, 4, shade(boots, 0.7), 0.05); // bottom = sole
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
    const info = modelInfo(model);
    return {
        model: 'classic',   // skin variant (classic 4px arms), not the LLM
        file: rel,          // path inside the MC server container (FabricTailor)
        path: rel,          // URL path served by the mindserver (web UI)
        generated: true,
        label: info.label,  // full model name, e.g. gpt-5.4-mini
        word: info.word,    // short word drawn on the chest
        color: info.color,  // family color, for UI badges
    };
}

/**
 * Replaces any stale or hand-authored profile skin with one derived from the
 * model that will actually run. Call this at the agent-registration boundary
 * so every creation and restart uses model-authoritative branding.
 */
export function synchronizeProfileSkin(profile) {
    if (!profile?.name) throw new Error('Cannot generate a skin without an agent name');
    if (!profile.model) throw new Error(`Cannot generate a skin for ${profile.name} without a model`);
    profile.skin = ensureSkin(profile.name, profile.model);
    return profile.skin;
}
