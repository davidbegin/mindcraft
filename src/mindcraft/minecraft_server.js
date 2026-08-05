import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const CONTAINER = process.env.MC_CONTAINER || 'mindcraft-mc';

export async function runMinecraftCommand(command, options = {}) {
    const { stdout } = await execFileAsync(
        'docker',
        ['exec', CONTAINER, 'rcon-cli', command],
        { timeout: options.timeoutMs ?? 15000 }
    );
    const response = stdout.trim();
    if (/(unknown or incomplete command|incorrect argument|cannot access blocks outside|too many blocks|that position is not loaded|no player was found)/i.test(response)) {
        throw new Error(`Minecraft rejected "${command}": ${response}`);
    }
    return response;
}
