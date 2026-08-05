// Tower battle is scored from the world at the deadline, not from bot submissions:
// every block a bot placed and left standing is grouped into towers, and each tower
// belongs to whoever laid the most of its blocks.

const DEFAULT_MERGE_DISTANCE = 2;

function columnKey(x, z) {
    return `${x},${z}`;
}

function collectColumns(reports, floorY) {
    const columns = new Map();
    for (const report of reports) {
        const participantId = report?.participantId;
        if (!participantId) continue;
        for (const block of report.blocks || []) {
            const x = Math.floor(block?.x);
            const y = Math.floor(block?.y);
            const z = Math.floor(block?.z);
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
            if (y <= floorY) continue;
            const key = columnKey(x, z);
            let column = columns.get(key);
            if (!column) {
                column = { x, z, topY: y, blocks: new Map() };
                columns.set(key, column);
            }
            column.topY = Math.max(column.topY, y);
            column.blocks.set(participantId, (column.blocks.get(participantId) ?? 0) + 1);
        }
    }
    return columns;
}

function clusterColumns(columns, mergeDistance) {
    const clusters = [];
    const visited = new Set();
    for (const [key, column] of columns) {
        if (visited.has(key)) continue;
        visited.add(key);
        const cluster = [];
        const queue = [column];
        while (queue.length > 0) {
            const current = queue.pop();
            cluster.push(current);
            for (let dx = -mergeDistance; dx <= mergeDistance; dx += 1) {
                for (let dz = -mergeDistance; dz <= mergeDistance; dz += 1) {
                    const neighborKey = columnKey(current.x + dx, current.z + dz);
                    if (visited.has(neighborKey)) continue;
                    const neighbor = columns.get(neighborKey);
                    if (!neighbor) continue;
                    visited.add(neighborKey);
                    queue.push(neighbor);
                }
            }
        }
        clusters.push(cluster);
    }
    return clusters;
}

function summarizeTower(cluster, floorY) {
    const contributions = new Map();
    let topY = floorY;
    for (const column of cluster) {
        topY = Math.max(topY, column.topY);
        for (const [participantId, count] of column.blocks) {
            contributions.set(participantId, (contributions.get(participantId) ?? 0) + count);
        }
    }
    const ranked = [...contributions.entries()].sort((left, right) =>
        right[1] - left[1] || left[0].localeCompare(right[0])
    );
    return {
        height: topY - floorY,
        topY,
        builderId: ranked[0]?.[0] ?? null,
        contributions: Object.fromEntries(ranked),
    };
}

export function measureTowers({ reports = [], floorY, mergeDistance = DEFAULT_MERGE_DISTANCE }) {
    if (!Number.isFinite(floorY)) {
        throw new TypeError('floorY must be a finite number');
    }
    return clusterColumns(collectColumns(reports, floorY), mergeDistance)
        .map(cluster => summarizeTower(cluster, floorY))
        .sort((left, right) => right.height - left.height);
}

export function scoreTowerBattle({
    reports = [],
    floorY,
    participantIds = null,
    mergeDistance = DEFAULT_MERGE_DISTANCE,
}) {
    const ids = participantIds?.length
        ? [...participantIds]
        : reports.map(report => report.participantId).filter(Boolean);
    const scored = reports.filter(report => ids.includes(report?.participantId));
    const towers = measureTowers({ reports: scored, floorY, mergeDistance });
    const reportById = new Map(scored.map(report => [report.participantId, report]));

    return ids.map(participantId => {
        const owned = towers.filter(tower => tower.builderId === participantId);
        const blocksStanding = towers.reduce(
            (total, tower) => total + (tower.contributions[participantId] ?? 0),
            0
        );
        const tallest = owned[0] ?? null;
        if (tallest) {
            return {
                participantId,
                score: tallest.height,
                disqualified: false,
                details: {
                    measuredFrom: 'placed-blocks',
                    towerHeight: tallest.height,
                    towerTopY: tallest.topY,
                    towersBuilt: owned.length,
                    blocksStanding,
                    contributions: tallest.contributions,
                },
            };
        }

        // A bot can finish on top of a pillar we never saw it place (block events
        // can be missed on reconnects), so fall back to what it is standing on.
        const standingY = reportById.get(participantId)?.standingOn?.y;
        const fallbackHeight = Number.isFinite(standingY) ? standingY - floorY : 0;
        if (blocksStanding === 0 && fallbackHeight > 0) {
            return {
                participantId,
                score: fallbackHeight,
                disqualified: false,
                details: {
                    measuredFrom: 'standing-pillar',
                    towerHeight: fallbackHeight,
                    towerTopY: standingY,
                    towersBuilt: 0,
                    blocksStanding,
                },
            };
        }

        return {
            participantId,
            score: 0,
            disqualified: false,
            details: {
                measuredFrom: blocksStanding > 0 ? 'helped-another-tower' : 'no-tower',
                towerHeight: 0,
                towersBuilt: 0,
                blocksStanding,
            },
        };
    });
}
