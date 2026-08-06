import assert from 'node:assert';

const STOP_WAIT_MS = 10000;
const STOP_POLL_MS = 300;

export class ActionManager {
    constructor(agent) {
        this.agent = agent;
        this.executing = false;
        this.currentActionLabel = '';
        this.currentActionFn = null;
        this.timedout = false;
        this.resume_func = null;
        this.resume_name = '';
        this.last_action_time = 0;
        this.recent_action_counter = 0;
        // Bumped on force-clear so a hung action finishing later cannot clear a newer one.
        this._actionId = 0;
    }

    async resumeAction(actionFn, timeout) {
        return this._executeResume(actionFn, timeout);
    }

    async runAction(actionLabel, actionFn, { timeout, resume = false } = {}) {
        if (resume) {
            return this._executeResume(actionLabel, actionFn, timeout);
        } else {
            return this._executeAction(actionLabel, actionFn, timeout);
        }
    }

    /**
     * Ask the current action to stop. If it does not yield within STOP_WAIT_MS,
     * force-clear executing state — never kill the agent process.
     * Process exits on stop timeouts were the main leave/rejoin disconnect loop.
     */
    async stop() {
        if (!this.executing) return;
        const label = this.currentActionLabel || '(unknown)';
        const deadline = Date.now() + STOP_WAIT_MS;
        while (this.executing && Date.now() < deadline) {
            this.agent.requestInterrupt();
            console.log('waiting for code to finish executing...');
            await new Promise(resolve => setTimeout(resolve, STOP_POLL_MS));
        }
        if (this.executing) {
            console.warn(
                `Action "${label}" did not stop after ${STOP_WAIT_MS / 1000}s; ` +
                'force-clearing without killing process.'
            );
            this.forceClear(`stop timeout: ${label}`);
        }
    }

    forceClear(reason = 'force clear') {
        try {
            this.agent.requestInterrupt();
        } catch (err) {
            console.warn('requestInterrupt during forceClear failed:', err?.message || err);
        }
        try {
            this.agent.bot?.clearControlStates?.();
        } catch (_) { /* bot may be mid-death */ }

        this._actionId++;
        this.executing = false;
        this.currentActionLabel = '';
        this.currentActionFn = null;
        this.timedout = true;
        this.cancelResume();
        console.warn(`[actions] forceClear (${reason})`);
    }

    cancelResume() {
        this.resume_func = null;
        this.resume_name = null;
    }

    _markRecordingEvent(type, data) {
        const atMs = Date.now();
        const recorders = [
            this.agent.pov_recorder,
            ...(this.agent.contest_recorders || []),
        ];
        for (const recorder of recorders) {
            try {
                recorder?.addMarker?.(type, data, atMs);
            } catch (_) {
                // Recording metadata is best-effort and must not affect actions.
            }
        }
    }

    async _executeResume(actionLabel = null, actionFn = null, timeout = 10) {
        const new_resume = actionFn != null;
        if (new_resume) { // start new resume
            this.resume_func = actionFn;
            assert(actionLabel != null, 'actionLabel is required for new resume');
            this.resume_name = actionLabel;
        }
        if (this.resume_func != null && (this.agent.isIdle() || new_resume) && (!this.agent.self_prompter.isActive() || new_resume)) {
            this.currentActionLabel = this.resume_name;
            let res = await this._executeAction(this.resume_name, this.resume_func, timeout);
            this.currentActionLabel = '';
            return res;
        } else {
            return { success: false, message: null, interrupted: false, timedout: false };
        }
    }

    async _executeAction(actionLabel, actionFn, timeout = 10) {
        let TIMEOUT;
        let actionId;
        try {
            if (this.last_action_time > 0) {
                let time_diff = Date.now() - this.last_action_time;
                if (time_diff < 20) {
                    this.recent_action_counter++;
                }
                else {
                    this.recent_action_counter = 0;
                }
                if (this.recent_action_counter > 3) {
                    console.warn('Fast action loop detected, cancelling resume.');
                    this.cancelResume(); // likely cause of repetition
                }
                if (this.recent_action_counter > 5) {
                    console.error('Infinite action loop detected, force-clearing without killing process.');
                    this.forceClear('infinite action loop');
                    this.recent_action_counter = 0;
                    return { success: false, message: 'Infinite action loop detected, force-cleared.', interrupted: false, timedout: false };
                }
            }
            this.last_action_time = Date.now();
            console.log('executing code...\n');

            // await current action to finish (executing=false), with 10 seconds timeout
            // also tell agent.bot to stop various actions
            if (this.executing) {
                console.log(`action "${actionLabel}" trying to interrupt current action "${this.currentActionLabel}"`);
            }
            await this.stop();

            // clear bot logs and reset interrupt code
            this.agent.clearBotLogs();

            actionId = ++this._actionId;
            this.executing = true;
            this.currentActionLabel = actionLabel;
            this.currentActionFn = actionFn;
            this.timedout = false;
            this._markRecordingEvent('action-start', { label: actionLabel });

            // timeout in minutes
            if (timeout > 0) {
                TIMEOUT = this._startTimeout(timeout);
            }

            // start the action
            await actionFn();

            // mark action as finished + cleanup only if we still own the slot
            if (actionId !== this._actionId) {
                this._markRecordingEvent('action-end', {
                    label: actionLabel,
                    outcome: 'superseded',
                });
                clearTimeout(TIMEOUT);
                return { success: false, message: 'Action superseded by interrupt/force-clear.', interrupted: true, timedout: true };
            }

            this._markRecordingEvent('action-end', {
                label: actionLabel,
                outcome: 'success',
            });
            this.executing = false;
            this.currentActionLabel = '';
            this.currentActionFn = null;
            clearTimeout(TIMEOUT);

            // get bot activity summary
            let output = this.getBotOutputSummary();
            let interrupted = this.agent.bot.interrupt_code;
            let timedout = this.timedout;
            this.agent.clearBotLogs();

            // if not interrupted and not generating, emit idle event
            if (!interrupted) {
                this.agent.bot.emit('idle');
            }

            // return action status report
            return { success: true, message: output, interrupted, timedout };
        } catch (err) {
            if (actionId != null) {
                this._markRecordingEvent('action-error', {
                    label: actionLabel,
                    message: err?.message || String(err),
                });
            }
            if (actionId == null || actionId === this._actionId) {
                this.executing = false;
                this.currentActionLabel = '';
                this.currentActionFn = null;
            }
            clearTimeout(TIMEOUT);
            this.cancelResume();
            console.error("Code execution triggered catch:", err);
            // Log the full stack trace
            console.error(err.stack);
            await this.stop();
            err = err.toString();

            let message = this.getBotOutputSummary() +
                '!!Code threw exception!!\n' +
                'Error: ' + err + '\n' +
                'Stack trace:\n' + err.stack+'\n';

            let interrupted = this.agent.bot.interrupt_code;
            this.agent.clearBotLogs();
            if (!interrupted) {
                this.agent.bot.emit('idle');
            }
            return { success: false, message, interrupted, timedout: false };
        }
    }

    getBotOutputSummary() {
        const { bot } = this.agent;
        if (bot.interrupt_code && !this.timedout) return '';
        let output = bot.output;
        const MAX_OUT = 500;
        if (output.length > MAX_OUT) {
            output = `Action output is very long (${output.length} chars) and has been shortened.\n
          First outputs:\n${output.substring(0, MAX_OUT / 2)}\n...skipping many lines.\nFinal outputs:\n ${output.substring(output.length - MAX_OUT / 2)}`;
        }
        else {
            output = 'Action output:\n' + output.toString();
        }
        bot.output = '';
        return output;
    }

    _startTimeout(TIMEOUT_MINS = 10) {
        return setTimeout(async () => {
            console.warn(`Code execution timed out after ${TIMEOUT_MINS} minutes. Attempting force stop.`);
            this.timedout = true;
            this.agent.history.add('system', `Code execution timed out after ${TIMEOUT_MINS} minutes. Attempting force stop.`);
            await this.stop(); // last attempt to stop (force-clears; never kills process)
        }, TIMEOUT_MINS * 60 * 1000);
    }

}
