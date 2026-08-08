import assert from 'node:assert/strict';
import test from 'node:test';

import {
    measureTeamTowerBattle,
    scoreTeamTowerBattle,
} from '../src/mindcraft/contest/team_tower_scoring.js';

const participantIds = ['alice', 'amy', 'bob', 'ben'];
const teamNames = ['Ember', 'Tide'];
const teamByParticipant = {
    alice: 'Ember',
    amy: 'Ember',
    bob: 'Tide',
    ben: 'Tide',
};

function report(participantId, blocks, standingOn = null) {
    return { participantId, blocks, standingOn };
}

test('teammates combine contributions into one owned tower', () => {
    const result = measureTeamTowerBattle({
        floorY: 100,
        participantIds,
        teamNames,
        teamByParticipant,
        reports: [
            report('alice', [{ x: 0, y: 101, z: 0 }, { x: 0, y: 108, z: 0 }]),
            report('amy', [{ x: 1, y: 104, z: 0 }, { x: 1, y: 110, z: 0 }]),
            report('bob', [{ x: 20, y: 101, z: 0 }, { x: 20, y: 107, z: 0 }]),
        ],
    });

    assert.equal(result.teamResults[0].teamName, 'Ember');
    assert.equal(result.teamResults[0].towerHeight, 10);
    assert.equal(result.teamResults[0].blocksStanding, 4);
    assert.equal(result.towers[0].teamOwner, 'Ember');
});

test('contested tower belongs to the team with the most standing blocks', () => {
    const result = measureTeamTowerBattle({
        floorY: 100,
        participantIds,
        teamNames,
        teamByParticipant,
        reports: [
            report('alice', [{ x: 0, y: 101, z: 0 }, { x: 0, y: 102, z: 0 }]),
            report('amy', [{ x: 1, y: 109, z: 0 }]),
            report('bob', [{ x: 1, y: 110, z: 1 }, { x: 1, y: 111, z: 1 }]),
        ],
    });

    assert.equal(result.towers[0].teamOwner, 'Ember');
    assert.equal(result.teamResults.find(team => team.teamName === 'Ember').towerHeight, 11);
});

test('subtracts five blocks for every team death and maps score to every member', () => {
    const options = {
        floorY: 100,
        participantIds,
        teamNames,
        teamByParticipant,
        deaths: { alice: 1, amy: 2 },
        deathPenaltyBlocks: 5,
        reports: [
            report('alice', [{ x: 0, y: 120, z: 0 }]),
            report('bob', [{ x: 20, y: 110, z: 0 }]),
        ],
    };
    const measured = measureTeamTowerBattle(options);
    const ember = measured.teamResults.find(team => team.teamName === 'Ember');
    assert.equal(ember.towerHeight, 20);
    assert.equal(ember.deaths, 3);
    assert.equal(ember.deathPenalty, 15);
    assert.equal(ember.score, 5);

    const scored = scoreTeamTowerBattle(options);
    assert.deepEqual(
        scored.filter(result => result.details.teamName === 'Ember').map(result => result.score),
        [5, 5]
    );
});

test('supports negative scores and tied team winners', () => {
    const result = measureTeamTowerBattle({
        floorY: 100,
        participantIds,
        teamNames,
        teamByParticipant,
        deaths: { alice: 1, bob: 1 },
        reports: [],
    });

    assert.deepEqual(result.teamResults.map(team => team.score), [-5, -5]);
});
