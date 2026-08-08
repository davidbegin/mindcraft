// Serves the real operator UI against a saved Survivor state, with no
// mindserver, no Minecraft, and no season running. Socket.IO is replaced by a
// stub that answers the handshake with the fixture, so the pages under
// src/mindcraft/public render exactly what they would render live.
//
//   node tools/survivor_ui_fixture.mjs /tmp/survivor-vote.json
//   node tools/fixture_server.mjs /tmp/survivor-vote.json
//   open http://localhost:8099/survivor
//
// The fixture is re-read on every request, so regenerating it and reloading the
// browser is the whole edit loop.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listContestGamePresets, listSurvivorScenarios } from '../src/mindcraft/contest/game_presets.js';
import { SurvivorSeasonArchive } from '../src/mindcraft/survivor/survivor_archive.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '../src/mindcraft/public');
const skinsDir = path.resolve(here, '../skins');
// The season archive reads the real journal on disk, so /seasons shows the
// seasons this machine has actually run rather than the fixture.
const archive = new SurvivorSeasonArchive({
    root: path.resolve(here, '../contests/survivor'),
});

const file = process.argv[2] || '/tmp/survivor-council.json';
const port = Number(process.argv[3] || 8099);

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.json': 'application/json',
};

// Enough of the Socket.IO client for the dashboards: named events, ack
// callbacks, and the .timeout(ms).emit(...) form. Acks are answered from the
// fixture; anything that would change server state resolves as a no-op success.
const SOCKET_STUB = `
window.io = function () {
    const handlers = {};
    let fixture = null;

    function ack(event, callback, args) {
        if (typeof callback !== 'function') return;
        // The archive is served from the real journal, so these two go to the
        // server rather than to the fixture.
        if (event === 'survivor-seasons') {
            fetch('/archive/seasons.json')
                .then(response => response.json())
                .then(callback);
            return;
        }
        if (event === 'survivor-season') {
            fetch('/archive/season.json?id=' + encodeURIComponent(args[0]?.seasonId || ''))
                .then(response => response.json())
                .then(callback);
            return;
        }
        if (event === 'survivor-status') {
            callback({
                success: true,
                data: fixture.state,
                games: fixture.games,
                scenarios: fixture.scenarios,
                secretEvents: fixture.secretEvents || [],
                join: fixture.join || null,
                preset: fixture.preset || null,
            });
            return;
        }
        if (event === 'list-profiles') {
            callback({ success: true, profiles: [] });
            return;
        }
        // Control actions cannot change a static fixture, so they hand the same
        // state straight back rather than pretending to have applied anything.
        callback({ success: true, data: fixture.state });
    }

    const socket = {
        on(event, handler) {
            (handlers[event] ||= []).push(handler);
            return socket;
        },
        off() { return socket; },
        emit(event, ...args) {
            ack(event, args[args.length - 1], args);
            return socket;
        },
        timeout() {
            return {
                emit(event, ...args) {
                    const callback = args[args.length - 1];
                    ack(event, typeof callback === 'function'
                        ? result => callback(null, result)
                        : undefined);
                    return socket;
                },
            };
        },
    };

    function fire(event, payload) {
        for (const handler of handlers[event] || []) handler(payload);
    }

    // Lets a browser session drive server-pushed events the fixture does not
    // carry, e.g. window.__fireSocketEvent('voice-health', {...}).
    window.__fireSocketEvent = fire;

    fetch('/fixture.json').then(response => response.json()).then(data => {
        fixture = data;
        fire('connect');
        fire('survivor-update', fixture.state);
        for (const entry of fixture.secretEvents || []) fire('survivor-secret-event', entry);
        console.log('[fixture] state loaded', fixture.state?.game?.phase);
    });

    return socket;
};
`;

function send(response, status, type, body) {
    response.statusCode = status;
    response.setHeader('Content-Type', type);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.end(body);
}

function fixturePayload() {
    return JSON.stringify({
        state: JSON.parse(readFileSync(file, 'utf8')),
        games: listContestGamePresets(),
        scenarios: listSurvivorScenarios(),
    });
}

createServer(async (request, response) => {
    const url = new URL(request.url, `http://localhost:${port}`);
    let pathname = url.pathname;

    try {
        if (pathname === '/socket.io/socket.io.js') {
            send(response, 200, TYPES['.js'], SOCKET_STUB);
            return;
        }
        if (pathname === '/fixture.json') {
            send(response, 200, TYPES['.json'], fixturePayload());
            return;
        }
        if (pathname === '/archive/seasons.json') {
            send(response, 200, TYPES['.json'], JSON.stringify({
                success: true,
                seasons: await archive.list(),
            }));
            return;
        }
        if (pathname === '/archive/season.json') {
            const season = await archive.get(url.searchParams.get('id'));
            send(response, 200, TYPES['.json'], JSON.stringify({
                success: Boolean(season),
                data: season,
                error: season ? null : 'No season on record with that id',
            }));
            return;
        }
        if (pathname === '/' || pathname === '/survivor') pathname = '/survivor.html';
        if (pathname === '/seasons') pathname = '/seasons.html';

        // Generated bot skins, so the portraits are the real in-game skins.
        const root = pathname.startsWith('/skins/') ? skinsDir : publicDir;
        const relative = pathname.startsWith('/skins/') ? pathname.slice('/skins/'.length) : pathname;
        const target = path.join(root, path.normalize(relative).replace(/^(\.\.[/\\])+/, ''));
        if (!target.startsWith(root)) {
            send(response, 403, 'text/plain', 'forbidden');
            return;
        }
        send(response, 200, TYPES[path.extname(target)] || 'application/octet-stream', readFileSync(target));
    } catch (error) {
        send(response, error.code === 'ENOENT' ? 404 : 500, 'text/plain', String(error.message));
    }
}).listen(port, () => {
    console.log(`fixture UI on http://localhost:${port}/survivor serving ${file}`);
});
