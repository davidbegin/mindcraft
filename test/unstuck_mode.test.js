import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('unstuck mode never cleanKills and ignores active digging', () => {
    const src = readFileSync(new URL('../src/agent/modes.js', import.meta.url), 'utf8');
    const start = src.indexOf("name: 'unstuck'");
    const end = src.indexOf("name: 'cowardice'");
    assert.ok(start >= 0 && end > start, 'expected unstuck mode before cowardice');
    const unstuck = src.slice(start, end);

    assert.doesNotMatch(unstuck, /cleanKill\s*\(/, 'failed unstuck must not restart the agent process');
    assert.match(unstuck, /Will NOT restart the agent process/);
    assert.match(unstuck, /never treat active digs as stuck/);
    assert.match(unstuck, /cooldown_until/);
    assert.match(unstuck, /not leaving/);
});
