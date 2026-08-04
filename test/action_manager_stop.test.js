import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ActionManager } from '../src/agent/action_manager.js';

test('stop never cleanKills the agent process', () => {
    const src = readFileSync(new URL('../src/agent/action_manager.js', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /cleanKill\s*\(/, 'stop/timeout paths must not kill the process');
    assert.match(src, /force-clearing without killing process/);
    assert.match(src, /forceClear/);
});

test('stop force-clears hung actions instead of exiting', async () => {
    let interrupts = 0;
    const agent = {
        cleanKill() {
            throw new Error('cleanKill must not be called from stop()');
        },
        requestInterrupt() {
            interrupts++;
        },
        bot: {
            interrupt_code: false,
            output: '',
            clearControlStates() {},
            emit() {},
        },
        clearBotLogs() {
            this.bot.interrupt_code = false;
            this.bot.output = '';
        },
        isIdle() { return !this.actions?.executing; },
        self_prompter: { isActive() { return false; } },
        history: { add() {} },
    };

    const actions = new ActionManager(agent);
    agent.actions = actions;
    actions.executing = true;
    actions.currentActionLabel = 'action:collectBlocks';

    const started = Date.now();
    await actions.stop();
    const elapsed = Date.now() - started;

    assert.equal(actions.executing, false);
    assert.ok(interrupts > 0, 'should request interrupts while waiting');
    assert.ok(elapsed >= 9000, `should wait ~10s before force-clear, got ${elapsed}ms`);
    assert.ok(elapsed < 15000, `should not hang forever, got ${elapsed}ms`);
    assert.ok(actions._actionId >= 1, 'force-clear should bump action id');
});

test('force-cleared action finishing later does not clear a newer action', async () => {
    const agent = {
        cleanKill() { throw new Error('cleanKill must not be called'); },
        requestInterrupt() {},
        bot: { interrupt_code: false, output: '', emit() {} },
        clearBotLogs() { this.bot.interrupt_code = false; this.bot.output = ''; },
        isIdle() { return false; },
        self_prompter: { isActive() { return false; } },
        history: { add() {} },
    };
    const actions = new ActionManager(agent);

    let releaseHung;
    const hung = new Promise(resolve => { releaseHung = resolve; });

    const first = actions.runAction('hung', async () => { await hung; }, { timeout: -1 });
    // let first claim executing
    await new Promise(r => setTimeout(r, 20));
    assert.equal(actions.executing, true);

    actions.forceClear('test');
    assert.equal(actions.executing, false);

    const second = await actions.runAction('next', async () => {
        assert.equal(actions.currentActionLabel, 'next');
    }, { timeout: -1 });
    assert.equal(second.success, true);
    assert.equal(actions.executing, false);

    releaseHung();
    const firstResult = await first;
    assert.equal(firstResult.interrupted, true);
    assert.equal(actions.executing, false, 'hung action must not clear newer idle state incorrectly');
    assert.equal(actions.currentActionLabel, '');
});
