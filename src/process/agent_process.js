import { spawn } from 'child_process';
import { logoutAgent } from '../mindcraft/mindserver.js';
import { attachAgentLog, record } from '../mindcraft/diagnostics/launch_telemetry.js';

function teeStream(stream, write, agentName, streamName) {
    if (!stream) return;
    let buffer = '';
    stream.on('data', (chunk) => {
        const text = chunk.toString();
        write(text);
        buffer += text;
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            attachAgentLog(agentName, line, streamName);
            newline = buffer.indexOf('\n');
        }
        if (buffer.length > 2000) {
            attachAgentLog(agentName, buffer, streamName);
            buffer = '';
        }
    });
    stream.on('end', () => {
        if (buffer.trim()) attachAgentLog(agentName, buffer, streamName);
    });
}

export class AgentProcess {
    constructor(id, name, port) {
        this.id = id;
        this.name = name;
        this.port = port;
    }

    start(load_memory=false, init_message=null, count_id=0) {
        this.count_id = count_id;
        this.running = true;

        let args = ['src/process/init_agent.js', this.name];
        args.push('-n', this.name);
        args.push('-i', this.id);
        args.push('-c', count_id);
        if (load_memory)
            args.push('-l', load_memory);
        if (init_message)
            args.push('-m', init_message);
        args.push('-p', this.port);

        // Use the same Node binary as MindServer so native addons (e.g. gl)
        // match the parent ABI instead of whichever `node` is first on PATH.
        // Pipe stdout/stderr so we can tee into launch telemetry while still
        // printing to the operator console.
        const agentProcess = spawn(process.execPath, args, {
            stdio: ['inherit', 'pipe', 'pipe'],
        });

        teeStream(agentProcess.stdout, (text) => process.stdout.write(text), this.name, 'stdout');
        teeStream(agentProcess.stderr, (text) => process.stderr.write(text), this.name, 'stderr');

        let last_restart = Date.now();
        agentProcess.on('exit', (code, signal) => {
            console.log(`Agent process exited with code ${code} and signal ${signal}`);
            this.running = false;
            record({
                level: code && code !== 0 ? 'error' : 'info',
                stage: 'agent_exit',
                agent: this.name,
                message: `Agent process exited with code ${code} and signal ${signal}`,
                detail: { code, signal, agentId: this.id },
            });
            logoutAgent(this.id);

            if (code > 1) {
                console.log(`Ending task`);
                process.exit(code);
            }

            if (code !== 0 && signal !== 'SIGINT') {
                // agent must run for at least 10 seconds before restarting
                if (Date.now() - last_restart < 10000) {
                    console.error(`Agent process exited too quickly and will not be restarted.`);
                    record({
                        level: 'error',
                        stage: 'agent_exit',
                        agent: this.name,
                        message: 'Agent process exited too quickly and will not be restarted',
                        detail: { code, signal, agentId: this.id },
                    });
                    return;
                }
                console.log('Restarting agent...');
                this.start(true, 'Agent process restarted.', count_id, this.port);
                last_restart = Date.now();
            }
        });

        agentProcess.on('error', (err) => {
            console.error('Agent process error:', err);
            record({
                level: 'error',
                stage: 'agent_exit',
                agent: this.name,
                message: `Agent process error: ${err.message}`,
                detail: { agentId: this.id },
            });
        });

        this.process = agentProcess;
    }

    stop() {
        if (!this.running) return;
        this.process.kill('SIGINT');
    }

    forceRestart() {
        if (this.running && this.process && !this.process.killed) {
            console.log(`Agent process for ${this.name} is still running. Attempting to force restart.`);

            const restartTimeout = setTimeout(() => {
                console.warn(`Agent ${this.name} did not stop in time. It might be stuck.`);
            }, 5000); // 5 seconds to exit

            this.process.once('exit', () => {
                 clearTimeout(restartTimeout);
                 console.log(`Stopped hanging agent ${this.name}. Now restarting.`);
                 this.start(true, 'Agent process restarted.', this.count_id);
            });
            this.stop(); // sends SIGINT
        } else {
             this.start(true, 'Agent process restarted.', this.count_id);
        }
    }
}
