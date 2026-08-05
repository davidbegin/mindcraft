import { execFile } from 'child_process';
import { promisify } from 'util';
import { modelInfo } from './skins.js';

// Vanilla scoreboard teams give every bot a nametag colored by model family
// with the full model name as a suffix (e.g. "explorer [gpt-5.4-mini]").
// Commands are sent over RCON through the Minecraft server's Docker container,
// so this works regardless of mods and applies to bots that are already online.

const execFileAsync = promisify(execFile);
const CONTAINER = process.env.MC_CONTAINER || 'mindcraft-mc';

async function rcon(command) {
    const { stdout } = await execFileAsync(
        'docker', ['exec', CONTAINER, 'rcon-cli', command],
        { timeout: 10000 }
    );
    return stdout.trim();
}

const configuredTeams = new Set();

export async function assignModelTeam(botName, model) {
    const info = modelInfo(model);
    const team = info.teamId;
    try {
        if (!configuredTeams.has(team)) {
            // "team add" fails harmlessly over RCON if the team already exists.
            await rcon(`team add ${team}`);
            await rcon(`team modify ${team} color ${info.mcColor}`);
            await rcon(`team modify ${team} suffix {text:" [${info.label}]",color:"${info.mcColor}"}`);
            configuredTeams.add(team);
        }
        const reply = await rcon(`team join ${team} ${botName}`);
        console.log(`Nametag team for ${botName}: ${reply || `joined ${team}`}`);
        return true;
    } catch (error) {
        console.warn(`Could not assign nametag team for ${botName} (${info.label}): ${error.message}`);
        return false;
    }
}
