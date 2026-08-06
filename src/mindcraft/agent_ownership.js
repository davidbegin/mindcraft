/**
 * Contest and Survivor bots are temporary: they borrow a Minecraft name for one
 * session and are never colony members. A retired colony agent can still hold a
 * record under that same name, so every colony reconciliation path must ask who
 * owns a connection before acting on it. Skipping this check lets the colony
 * stop, re-task, or retire a bot that a game just spawned.
 */
export function isGameSessionAgent(connection) {
    return Boolean(connection?.settings?.game_session);
}

export function colonyControlsAgent(connection) {
    return Boolean(connection) && !isGameSessionAgent(connection);
}
