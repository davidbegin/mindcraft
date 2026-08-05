import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { createCanvas, Image } from 'canvas';

// Generates deterministic 64x64 Minecraft skins so every bot is visually unique
// and its LLM model is identifiable at a glance:
//  - a solid model-family color band wraps the chest and both arms, with the
//    model's short word (MINI/SOL/TERA/LUNA) spelled out across the front
//  - the model provider's logo is drawn on the back of the torso
//  - hair, headband, pants, and skin tone are derived from the bot's name

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SKINS_DIR = path.resolve(__dirname, '../../skins');
export const LOGOS_DIR = path.resolve(__dirname, '../../assets/model-logos');
// The MC container bind-mounts SKINS_DIR at /skins, and the mindserver serves
// it at /skins, so one path string works for both FabricTailor and the web UI.
export const SKINS_MOUNT = '/skins';

const MODEL_FAMILIES = [
    { match: /mini/i,  key: 'mini',  word: 'MINI', color: '#2fd3c9', mcColor: 'aqua' },
    { match: /sol/i,   key: 'sol',   word: 'SOL',  color: '#ffb32b', mcColor: 'gold' },
    { match: /terra/i, key: 'terra', word: 'TERA', color: '#5fc953', mcColor: 'green' },
    { match: /luna/i,  key: 'luna',  word: 'LUNA', color: '#c77dff', mcColor: 'light_purple' },
];

// Maps model names (and API providers as a fallback) to the company whose
// logo goes on the skin. Order matters: model-maker patterns come first so
// e.g. a llama model served through groq still shows Meta's logo.
const PROVIDER_PATTERNS = [
    [/gpt|davinci|openai|^o[0-9]/i, 'openai'],
    [/claude|anthropic/i, 'anthropic'],
    [/gemini|gemma|palm|bard/i, 'gemini'],
    [/mistral|mixtral|codestral|ministral/i, 'mistral'],
    [/llama|meta/i, 'meta'],
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

    // Model band (rows 20-26) around front + sides; front carries the word
    // (letters occupy rows 21-25, leaving a 1px color margin above and below).
    box(20, 20, 8, 7, info.color);
    box(16, 20, 4, 7, info.color);
    box(28, 20, 4, 7, info.color);
    // Word split: first letter on right arm, middle on torso, last on left arm.
    const word = info.word;
    const middle = word.length <= 2 ? word : word.slice(1, -1);
    drawWordRow(middle, 20, 8, 21, bandText);
    // Belt with family-color buckle.
    box(20, 30, 8, 1, boots);
    px(23, 30, info.color); px(24, 30, info.color);

    // Back: official model-provider logo on the shirt.
    drawBitmap(logoBitmap(info.provider), 32, 22, '#ffffff');
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
        for (const fx of [bx, bx + 4, bx + 8, bx + 12]) box(fx, by + 4, 4, 7, info.color);
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
