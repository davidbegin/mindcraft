// Serves a Survivor state fixture with permissive CORS so the operator UI can
// be driven from a browser console without a live season running.
//
//   node tools/survivor_ui_fixture.mjs > /tmp/survivor-council.json
//   node tools/fixture_server.mjs /tmp/survivor-council.json

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const file = process.argv[2] || '/tmp/survivor-council.json';
const port = Number(process.argv[3] || 8099);

createServer((_request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Content-Type', 'application/json');
    try {
        response.end(readFileSync(file));
    } catch (error) {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: error.message }));
    }
}).listen(port, () => {
    console.log(`fixture server on ${port} serving ${file}`);
});
