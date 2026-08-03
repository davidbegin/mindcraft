import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

function loadEnvFile(path) {
    if (!existsSync(path)) return {};
    const loaded = {};
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
        const eq = trimmed.indexOf('=');
        const name = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        loaded[name] = value;
    }
    return loaded;
}

let keys = {};
// Root .env wins over code/.env, and both win over keys.json / process.env
const envFromFile = {
    ...loadEnvFile(resolve('code/.env')),
    ...loadEnvFile(resolve('.env')),
};
try {
    const data = readFileSync('./keys.json', 'utf8');
    keys = { ...JSON.parse(data), ...envFromFile };
} catch (err) {
    keys = { ...envFromFile };
    console.warn('keys.json not found. Defaulting to code/.env and environment variables.');
}

export function getKey(name) {
    let key = keys[name];
    if (!key) {
        key = process.env[name];
    }
    if (!key) {
        throw new Error(`API key "${name}" not found in keys.json or environment variables!`);
    }
    return key;
}

export function hasKey(name) {
    return keys[name] || process.env[name];
}
