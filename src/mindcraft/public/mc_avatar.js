// Draws bot portraits from the 64x64 skin textures the mindserver generates and
// serves at /skins/<name>.png, so a face in the UI is the same face that is
// standing on the mat in Minecraft. Compositing the texture ourselves (rather
// than asking a render service for a picture) keeps the model band on the chest
// legible and works with no network at all.
(function () {
    // A bot whose skin has not been generated yet (or a real player who wandered
    // into a season) still gets a face, from the public render of their name.
    const SKIN_SOURCES = [
        name => `/skins/${encodeURIComponent(name)}.png`,
        name => `https://mc-heads.net/skin/${encodeURIComponent(name)}`,
    ];

    const MODES = {
        head: { width: 8, height: 8 },
        body: { width: 16, height: 32 },
    };

    const skins = new Map();

    function loadImage(url) {
        return new Promise(resolve => {
            const image = new Image();
            image.onload = () => resolve(image.naturalWidth > 0 ? image : null);
            image.onerror = () => resolve(null);
            image.src = url;
        });
    }

    async function loadSkin(name) {
        for (const source of SKIN_SOURCES) {
            const image = await loadImage(source(name));
            if (image) return image;
        }
        return null;
    }

    function skinFor(name) {
        if (!skins.has(name)) skins.set(name, loadSkin(name));
        return skins.get(name);
    }

    function drawHead(ctx, image) {
        ctx.drawImage(image, 8, 8, 8, 8, 0, 0, 8, 8);
        ctx.drawImage(image, 40, 8, 8, 8, 0, 0, 8, 8);   // hat layer
    }

    function drawBody(ctx, image) {
        // 64x32 skins predate separate left limbs, so those reuse the right ones.
        const legacy = image.naturalHeight < 64;
        const part = (sx, sy, w, h, dx, dy) => ctx.drawImage(image, sx, sy, w, h, dx, dy, w, h);
        part(8, 8, 8, 8, 4, 0);                                    // head
        part(40, 8, 8, 8, 4, 0);                                   // hat layer
        part(20, 20, 8, 12, 4, 8);                                 // torso
        part(44, 20, 4, 12, 0, 8);                                 // right arm
        part(legacy ? 44 : 36, legacy ? 20 : 52, 4, 12, 12, 8);    // left arm
        part(4, 20, 4, 12, 4, 20);                                 // right leg
        part(legacy ? 4 : 20, legacy ? 20 : 52, 4, 12, 8, 20);     // left leg
    }

    function hue(name) {
        let hash = 2166136261;
        for (let index = 0; index < name.length; index++) {
            hash ^= name.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0) % 360;
    }

    function drawPlaceholder(ctx, mode, name) {
        const spec = MODES[mode];
        ctx.fillStyle = `hsl(${hue(name)} 40% 30%)`;
        ctx.fillRect(0, 0, spec.width, spec.height);
        ctx.fillStyle = `hsl(${hue(name)} 45% 45%)`;
        ctx.fillRect(0, 0, spec.width, Math.max(1, Math.round(spec.height / 4)));
    }

    function attribute(value) {
        return String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    }

    // Markup only: callers drop this into any innerHTML and then call paint().
    function html(name, options = {}) {
        const mode = MODES[options.mode] ? options.mode : 'head';
        const spec = MODES[mode];
        const scale = options.scale || 4;
        const extra = options.className ? ` ${attribute(options.className)}` : '';
        return `<canvas class="mc-av mc-av-${mode}${extra}"`
            + ` width="${spec.width}" height="${spec.height}"`
            + ` style="width:${spec.width * scale}px;height:${spec.height * scale}px"`
            + ` data-mc-avatar="${attribute(name)}" data-mc-mode="${mode}"`
            + ` role="img" aria-label="${attribute(name)}" title="${attribute(name)}"></canvas>`;
    }

    // Safe to call after every render: canvases are marked once painted, and the
    // decoded textures are cached, so repeat calls cost a lookup per portrait.
    function paint(root) {
        const scope = root || document;
        for (const canvas of scope.querySelectorAll('canvas[data-mc-avatar]:not([data-mc-painted])')) {
            canvas.dataset.mcPainted = '1';
            const name = canvas.dataset.mcAvatar;
            const mode = canvas.dataset.mcMode === 'body' ? 'body' : 'head';
            skinFor(name).then(image => {
                const ctx = canvas.getContext('2d');
                ctx.imageSmoothingEnabled = false;
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                if (image) {
                    if (mode === 'body') drawBody(ctx, image);
                    else drawHead(ctx, image);
                } else {
                    drawPlaceholder(ctx, mode, name);
                }
            });
        }
    }

    window.mcAvatar = { html, paint };
})();
