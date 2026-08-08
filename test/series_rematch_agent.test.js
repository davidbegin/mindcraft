import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * Mirrors the game-directive handler in mindserver_proxy: opening a match
 * (gameStarted true) clears the previous elimination so series rematches count.
 */
function applyGameDirectiveFlags(agent, directive) {
    if (directive.gameStarted === true) {
        agent._contestEliminatedReported = false;
        agent.gameStarted = true;
    } else if (directive.gameStarted === false) {
        agent.gameStarted = false;
    }
    return agent;
}

test('gameStarted true clears elimination so a series rematch fall can count', () => {
    const agent = {
        gameStarted: false,
        _contestEliminatedReported: true,
    };
    applyGameDirectiveFlags(agent, { gameStarted: false });
    assert.equal(agent.gameStarted, false);
    assert.equal(agent._contestEliminatedReported, true);

    applyGameDirectiveFlags(agent, { gameStarted: true });
    assert.equal(agent.gameStarted, true);
    assert.equal(agent._contestEliminatedReported, false);
});
