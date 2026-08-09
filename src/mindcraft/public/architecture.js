import { SECTIONS, NODES } from './architecture_content.js';

const MERMAID_CDN = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';

const MERMAID_CONFIG = {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    fontFamily: '"DM Sans", system-ui, sans-serif',
    themeVariables: {
        background: '#1a221e',
        primaryColor: '#1f2a24',
        primaryTextColor: '#e8efe9',
        primaryBorderColor: '#3d4d45',
        secondaryColor: '#22302a',
        tertiaryColor: '#161c19',
        lineColor: '#6c8177',
        textColor: '#e8efe9',
        nodeTextColor: '#e8efe9',
        clusterBkg: '#121815',
        clusterBorder: '#2a3530',
        titleColor: '#9fe870',
        edgeLabelBackground: '#161c19',
        actorBkg: '#1f2a24',
        actorBorder: '#3d4d45',
        actorTextColor: '#e8efe9',
        actorLineColor: '#6c8177',
        signalColor: '#c7d5ca',
        signalTextColor: '#c7d5ca',
        labelBoxBkgColor: '#1f2a24',
        labelBoxBorderColor: '#3d4d45',
        labelTextColor: '#e8efe9',
        loopTextColor: '#c7d5ca',
        noteBkgColor: '#22302a',
        noteBorderColor: '#3d4d45',
        noteTextColor: '#e8efe9',
        transitionColor: '#6c8177',
        transitionLabelColor: '#c7d5ca',
    },
    flowchart: { htmlLabels: false, useMaxWidth: false, curve: 'basis', padding: 14, nodeSpacing: 46, rankSpacing: 52 },
    sequence: { useMaxWidth: false, actorMargin: 58, mirrorActors: false, noteAlign: 'left' },
    state: { useMaxWidth: false, nodeSpacing: 46 },
};

const MIN_SCALE = 0.2;
const MAX_SCALE = 4;

const el = {
    sections: document.getElementById('sections'),
    tocNav: document.getElementById('tocNav'),
    article: document.getElementById('article'),
    layout: document.getElementById('layout'),
    drawer: document.getElementById('drawer'),
    drawerTitle: document.getElementById('drawerTitle'),
    drawerKind: document.getElementById('drawerKind'),
    drawerBody: document.getElementById('drawerBody'),
    drawerClose: document.getElementById('drawerClose'),
};

/** Every rendered diagram, so node selection can be cleared across all of them. */
const diagrams = [];
let selectedNodeKey = null;

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/* —————————————————————— block rendering —————————————————————— */

function renderProse(block) {
    const node = document.createElement('div');
    node.className = 'prose';
    node.innerHTML = block.html;
    return node;
}

function renderTable(block) {
    const wrap = document.createElement('div');
    wrap.className = 'doc-table-wrap';
    const head = block.head.map((h) => `<th>${escapeHtml(h)}</th>`).join('');
    const rows = block.rows
        .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
        .join('');
    wrap.innerHTML = `
        ${block.title ? `<div class="doc-table-title">${escapeHtml(block.title)}</div>` : ''}
        <table class="doc-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
    return wrap;
}

function renderFacts(block) {
    const wrap = document.createElement('div');
    wrap.className = 'facts';
    const items = block.items
        .map(([label, value]) => `
            <dl class="fact">
                <dt>${escapeHtml(label)}</dt>
                <dd>${escapeHtml(value)}</dd>
            </dl>`)
        .join('');
    wrap.innerHTML = `
        ${block.title ? `<div class="facts-title">${escapeHtml(block.title)}</div>` : ''}
        <div class="facts-grid">${items}</div>`;
    return wrap;
}

function renderSteps(block) {
    const wrap = document.createElement('div');
    wrap.className = 'steps';
    const items = block.items
        .map((item) => `
            <div class="step">
                <div class="step-num"></div>
                <div class="step-body">
                    <div class="step-name">${escapeHtml(item.name)}</div>
                    <div class="step-detail">${escapeHtml(item.detail)}</div>
                </div>
            </div>`)
        .join('');
    wrap.innerHTML = `
        ${block.title ? `<div class="steps-title">${escapeHtml(block.title)}</div>` : ''}
        ${items}`;
    return wrap;
}

function renderCode(block) {
    const wrap = document.createElement('div');
    wrap.className = 'code-block';
    wrap.innerHTML = `
        ${block.title ? `<div class="code-title">${escapeHtml(block.title)}</div>` : ''}
        <pre>${escapeHtml(block.text)}</pre>`;
    return wrap;
}

function renderDiagramShell(block) {
    const wrap = document.createElement('figure');
    wrap.className = 'diagram';
    wrap.id = `diagram-${block.id}`;
    wrap.innerHTML = `
        <div class="diagram-head">
            <h4>${escapeHtml(block.title)}</h4>
            <div class="diagram-tools">
                <button class="tool-btn" type="button" data-act="out" title="Zoom out" aria-label="Zoom out">&minus;</button>
                <button class="tool-btn" type="button" data-act="in" title="Zoom in" aria-label="Zoom in">+</button>
                <button class="tool-btn wide" type="button" data-act="fit" title="Fit to view">fit</button>
                <button class="tool-btn wide" type="button" data-act="expand" title="Toggle tall view">tall</button>
            </div>
            <span class="diagram-hint">loading…</span>
        </div>
        <div class="diagram-stage"><div class="diagram-canvas"></div></div>
        ${block.caption ? `<figcaption class="diagram-caption">${escapeHtml(block.caption)}</figcaption>` : ''}`;
    return wrap;
}

function renderBlock(block) {
    switch (block.type) {
        case 'prose':
            return renderProse(block);
        case 'table':
            return renderTable(block);
        case 'facts':
            return renderFacts(block);
        case 'steps':
            return renderSteps(block);
        case 'code':
            return renderCode(block);
        case 'diagram':
            return renderDiagramShell(block);
        default: {
            const exhaustive = block.type;
            console.warn('Unknown architecture block type', exhaustive);
            return document.createElement('div');
        }
    }
}

function renderSections() {
    const frag = document.createDocumentFragment();
    const tocFrag = document.createDocumentFragment();

    for (const section of SECTIONS) {
        const node = document.createElement('section');
        node.className = 'section';
        node.id = section.id;
        node.innerHTML = `
            <div class="section-eyebrow">${escapeHtml(section.eyebrow)}</div>
            <h3>${escapeHtml(section.title)}</h3>`;
        for (const block of section.blocks) node.appendChild(renderBlock(block));
        frag.appendChild(node);

        const link = document.createElement('a');
        link.href = `#${section.id}`;
        link.textContent = section.title;
        link.dataset.target = section.id;
        tocFrag.appendChild(link);
    }

    el.sections.appendChild(frag);
    el.tocNav.appendChild(tocFrag);
}

/* —————————————————————— diagram interactivity —————————————————————— */

function applyTransform(view) {
    view.canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
}

function fitDiagram(view) {
    const stage = view.stage;
    const stageWidth = stage.clientWidth;
    const stageHeight = stage.clientHeight;
    if (!stageWidth || !stageHeight || !view.width || !view.height) return;

    const padding = 24;
    const scale = Math.min(
        (stageWidth - padding * 2) / view.width,
        (stageHeight - padding * 2) / view.height,
        1.35,
    );
    view.scale = Math.max(MIN_SCALE, scale);
    view.x = (stageWidth - view.width * view.scale) / 2;
    view.y = (stageHeight - view.height * view.scale) / 2;
    applyTransform(view);
}

function zoomBy(view, factor, originX, originY) {
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
    if (next === view.scale) return;
    // Keep the point under the cursor (or stage center) pinned while scaling.
    view.x = originX - ((originX - view.x) * next) / view.scale;
    view.y = originY - ((originY - view.y) * next) / view.scale;
    view.scale = next;
    applyTransform(view);
}

function wirePanAndZoom(view, figure) {
    const stage = view.stage;

    stage.addEventListener('wheel', (event) => {
        if (!event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        const rect = stage.getBoundingClientRect();
        zoomBy(view, event.deltaY < 0 ? 1.12 : 1 / 1.12, event.clientX - rect.left, event.clientY - rect.top);
    }, { passive: false });

    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let originX = 0;
    let originY = 0;
    let moved = false;

    stage.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        pointerId = event.pointerId;
        startX = event.clientX;
        startY = event.clientY;
        originX = view.x;
        originY = view.y;
        moved = false;
        stage.classList.add('grabbing');
        stage.setPointerCapture(pointerId);
    });

    stage.addEventListener('pointermove', (event) => {
        if (pointerId !== event.pointerId) return;
        const dx = event.clientX - startX;
        const dy = event.clientY - startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
        view.x = originX + dx;
        view.y = originY + dy;
        applyTransform(view);
    });

    const endPan = (event) => {
        if (pointerId !== event.pointerId) return;
        stage.classList.remove('grabbing');
        stage.releasePointerCapture(pointerId);
        pointerId = null;
        // Suppress the click that follows a drag so panning never opens the drawer.
        view.suppressClick = moved;
    };

    stage.addEventListener('pointerup', endPan);
    stage.addEventListener('pointercancel', endPan);
    stage.addEventListener('dblclick', () => fitDiagram(view));

    figure.querySelector('.diagram-tools').addEventListener('click', (event) => {
        const button = event.target.closest('button');
        if (!button) return;
        const centerX = stage.clientWidth / 2;
        const centerY = stage.clientHeight / 2;
        switch (button.dataset.act) {
            case 'in':
                zoomBy(view, 1.25, centerX, centerY);
                break;
            case 'out':
                zoomBy(view, 1 / 1.25, centerX, centerY);
                break;
            case 'fit':
                fitDiagram(view);
                break;
            case 'expand':
                stage.style.height = stage.style.height === '78vh' ? '' : '78vh';
                button.textContent = stage.style.height ? 'short' : 'tall';
                requestAnimationFrame(() => fitDiagram(view));
                break;
            default:
                break;
        }
    });
}

/** Mermaid ids look like `flowchart-mindServer-3`; recover the id from the source. */
function nodeKeyFor(element) {
    const dataId = element.dataset?.id;
    if (dataId && NODES[dataId]) return dataId;

    const raw = element.id || '';
    const prefixed = raw.match(/^(?:flowchart|state|stateDiagram)[-_](.+?)-\d+$/);
    if (prefixed && NODES[prefixed[1]]) return prefixed[1];

    const trailing = raw.match(/^(.+?)-\d+$/);
    if (trailing && NODES[trailing[1]]) return trailing[1];

    return NODES[raw] ? raw : null;
}

function wireNodes(view) {
    let clickable = 0;

    for (const element of view.svg.querySelectorAll('g.node, g.statediagram-state')) {
        const key = nodeKeyFor(element);
        if (!key) continue;
        clickable += 1;
        element.classList.add('doc-node');
        element.dataset.nodeKey = key;
        element.setAttribute('tabindex', '0');
        element.setAttribute('role', 'button');
        element.setAttribute('aria-label', `${NODES[key].title} details`);

        element.addEventListener('click', () => {
            if (view.suppressClick) {
                view.suppressClick = false;
                return;
            }
            openDrawer(key);
        });

        element.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            openDrawer(key);
        });
    }

    return clickable;
}

async function renderDiagram(mermaid, block) {
    const figure = document.getElementById(`diagram-${block.id}`);
    if (!figure) return;

    const stage = figure.querySelector('.diagram-stage');
    const canvas = figure.querySelector('.diagram-canvas');
    const hint = figure.querySelector('.diagram-hint');

    let svgText;
    try {
        ({ svg: svgText } = await mermaid.render(`mmd-${block.id}`, block.mermaid));
    } catch (error) {
        console.error(`Failed to render diagram ${block.id}`, error);
        showFallback(figure, block, 'This diagram failed to render. Source below.');
        return;
    }

    canvas.innerHTML = svgText;
    const svg = canvas.querySelector('svg');
    if (!svg) {
        showFallback(figure, block, 'This diagram produced no output. Source below.');
        return;
    }

    const box = svg.viewBox?.baseVal;
    const width = box?.width || svg.getBoundingClientRect().width || 800;
    const height = box?.height || svg.getBoundingClientRect().height || 400;
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.style.width = `${width}px`;
    svg.style.height = `${height}px`;

    const view = { stage, canvas, svg, width, height, scale: 1, x: 0, y: 0, suppressClick: false };
    diagrams.push(view);

    const clickable = wireNodes(view);
    wirePanAndZoom(view, figure);
    fitDiagram(view);

    hint.textContent = clickable
        ? 'drag to pan · ctrl+scroll to zoom · click a node'
        : 'drag to pan · ctrl+scroll to zoom';
}

function showFallback(figure, block, message) {
    const stage = figure.querySelector('.diagram-stage');
    const hint = figure.querySelector('.diagram-hint');
    const tools = figure.querySelector('.diagram-tools');
    tools.remove();
    hint.textContent = 'source';
    stage.className = 'diagram-fallback';
    stage.innerHTML = `<div class="diagram-error">${escapeHtml(message)}</div><pre>${escapeHtml(block.mermaid)}</pre>`;
}

/* —————————————————————— detail drawer —————————————————————— */

function groupList(title, items, className = '') {
    if (!items?.length) return '';
    const rows = items.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
    return `
        <div class="drawer-group ${className}">
            <h4>${escapeHtml(title)}</h4>
            <ul>${rows}</ul>
        </div>`;
}

function groupChips(title, items, chipClass) {
    if (!items?.length) return '';
    const chips = items.map((item) => `<span class="chip ${chipClass}">${escapeHtml(item)}</span>`).join('');
    return `
        <div class="drawer-group">
            <h4>${escapeHtml(title)}</h4>
            <div class="chip-row">${chips}</div>
        </div>`;
}

function openDrawer(key) {
    const node = NODES[key];
    if (!node) return;

    selectedNodeKey = key;
    highlightSelection();

    el.drawerTitle.textContent = node.title;
    el.drawerKind.textContent = node.kind || '';
    el.drawerKind.hidden = !node.kind;
    el.drawerBody.innerHTML = `
        <p class="drawer-summary">${escapeHtml(node.summary)}</p>
        ${groupChips('Emits', node.emits, 'out')}
        ${groupChips('Listens for', node.listens, 'in')}
        ${groupList('Key files', node.files, 'files')}
        ${groupList('Notes', node.notes)}`;

    el.drawer.hidden = false;
    el.layout.classList.add('drawer-open');
    // The stage size changes when the drawer opens, so every diagram needs a refit.
    requestAnimationFrame(() => diagrams.forEach(fitDiagram));
}

function closeDrawer() {
    selectedNodeKey = null;
    highlightSelection();
    el.drawer.hidden = true;
    el.layout.classList.remove('drawer-open');
    requestAnimationFrame(() => diagrams.forEach(fitDiagram));
}

function highlightSelection() {
    for (const view of diagrams) {
        for (const element of view.svg.querySelectorAll('.doc-node')) {
            element.classList.toggle('selected', element.dataset.nodeKey === selectedNodeKey);
        }
    }
}

/* —————————————————————— navigation —————————————————————— */

function wireTableOfContents() {
    const links = new Map();
    for (const link of el.tocNav.querySelectorAll('a')) links.set(link.dataset.target, link);

    const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            for (const link of links.values()) link.classList.remove('active');
            links.get(entry.target.id)?.classList.add('active');
        }
    }, { root: el.article, rootMargin: '-10% 0px -75% 0px', threshold: 0 });

    for (const section of el.sections.querySelectorAll('.section')) observer.observe(section);

    el.tocNav.addEventListener('click', (event) => {
        const link = event.target.closest('a');
        if (!link) return;
        event.preventDefault();
        const target = document.getElementById(link.dataset.target);
        if (!target) return;
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        history.replaceState(null, '', `#${link.dataset.target}`);
    });
}

function scrollToHash() {
    const id = decodeURIComponent(location.hash.replace('#', ''));
    if (!id) return;
    document.getElementById(id)?.scrollIntoView({ block: 'start' });
}

/* —————————————————————— boot —————————————————————— */

async function loadMermaid() {
    // Imported at runtime rather than statically so the page still renders
    // (with diagram sources as text) when the CDN is unreachable.
    const module = await import(MERMAID_CDN);
    const mermaid = module.default;
    mermaid.initialize(MERMAID_CONFIG);
    return mermaid;
}

async function init() {
    renderSections();
    wireTableOfContents();

    el.drawerClose.addEventListener('click', closeDrawer);
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !el.drawer.hidden) closeDrawer();
    });

    const diagramBlocks = SECTIONS.flatMap((section) => section.blocks.filter((block) => block.type === 'diagram'));

    let mermaid;
    try {
        mermaid = await loadMermaid();
    } catch (error) {
        console.error('Mermaid failed to load', error);
        for (const block of diagramBlocks) {
            const figure = document.getElementById(`diagram-${block.id}`);
            if (figure) showFallback(figure, block, 'Diagram rendering is unavailable offline. Source below.');
        }
        scrollToHash();
        return;
    }

    for (const block of diagramBlocks) await renderDiagram(mermaid, block);

    let resizeTimer = null;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => diagrams.forEach(fitDiagram), 150);
    });

    scrollToHash();
}

init().catch((error) => {
    console.error('Architecture page failed to initialize', error);
});
