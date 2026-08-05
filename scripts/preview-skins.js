#!/usr/bin/env node
// Renders front + back views of generated skins into a single preview image.
// Usage: node scripts/preview-skins.js out.png name:model [name:model ...]
import { createCanvas, loadImage } from 'canvas';
import { writeFileSync } from 'fs';
import { renderSkin } from '../src/mindcraft/skins.js';

const [out, ...specs] = process.argv.slice(2);
if (!out || specs.length === 0) {
    console.error('Usage: node scripts/preview-skins.js out.png name:model [...]');
    process.exit(1);
}

const SCALE = 6;
const COL_W = 20 * SCALE + 10;
const canvas = createCanvas(specs.length * COL_W + 10, 2 * 34 * SCALE + 30);
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;
ctx.fillStyle = '#555';
ctx.fillRect(0, 0, canvas.width, canvas.height);

// [sx, sy, sw, sh, dx, dy] regions of a 64x64 skin composed into a body view.
const FRONT = [
    [8, 8, 8, 8, 4, 1], [40, 8, 8, 8, 4, 1],      // head + hat layer
    [20, 20, 8, 12, 4, 9],                        // torso
    [44, 20, 4, 12, 0, 9], [36, 52, 4, 12, 12, 9], // arms
    [4, 20, 4, 12, 4, 21], [20, 52, 4, 12, 8, 21], // legs
];
const BACK = [
    [24, 8, 8, 8, 4, 36], [56, 8, 8, 8, 4, 36],
    [32, 20, 8, 12, 4, 44],
    [52, 20, 4, 12, 0, 44], [44, 52, 4, 12, 12, 44],
    [12, 20, 4, 12, 4, 56], [28, 52, 4, 12, 8, 56],
];

for (let i = 0; i < specs.length; i++) {
    const [name, ...modelParts] = specs[i].split(':');
    const model = modelParts.join(':');
    const img = await loadImage(renderSkin(name, model).toBuffer('image/png'));
    const ox = i * COL_W + 10;
    for (const [sx, sy, sw, sh, dx, dy] of [...FRONT, ...BACK]) {
        ctx.drawImage(img, sx, sy, sw, sh, ox + dx * SCALE, dy * SCALE, sw * SCALE, sh * SCALE);
    }
}

writeFileSync(out, canvas.toBuffer('image/png'));
console.log(`wrote ${out} (${specs.length} skins, front + back)`);
