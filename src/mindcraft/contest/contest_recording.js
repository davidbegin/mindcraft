function overviewCameras(arena) {
    const { x, y, z } = arena.center;
    const target = { x, y: y + 8, z };
    return [
        {
            id: 'contest-wide-northeast',
            position: { x: x + 52, y: y + 38, z: z + 52 },
            target,
            fps: 15,
            viewDistance: 8,
        },
        {
            id: 'contest-wide-southwest',
            position: { x: x - 52, y: y + 28, z: z - 52 },
            target,
            fps: 15,
            viewDistance: 8,
        },
    ];
}

function participantWideCamera(agentName) {
    const safeName = String(agentName).replace(/[^a-zA-Z0-9_.-]+/g, '-');
    return {
        id: `${safeName}-wide-follow`,
        camera: 'follow',
        recordingRole: 'participant-wide',
        followDistance: 12,
        followHeight: 4,
        fps: 20,
        width: 854,
        height: 480,
        viewDistance: 8,
    };
}

export class ContestRecordingManager {
    constructor(options = {}) {
        if (typeof options.requestAgent !== 'function') {
            throw new TypeError('requestAgent must be a function');
        }
        this.requestAgent = options.requestAgent;
        this.clock = options.clock || Date.now;
        this.active = null;
    }

    async start({ contestId, participants, arena }) {
        if (this.active) {
            throw new Error(`Recording session ${this.active.sessionId} is already active`);
        }
        if (!contestId || !participants?.length || !arena?.center) {
            throw new Error('Contest recording requires a contest, participants, and arena');
        }

        const sessionId = `contest-${contestId}`;
        const syncEpochMs = this.clock();
        const observer = participants[0];
        const requests = participants.map(agentName => ({
            agentName,
            options: {
                sessionId,
                contestId,
                syncEpochMs,
                externalCameras: [
                    participantWideCamera(agentName),
                    ...(agentName === observer ? overviewCameras(arena) : []),
                ],
            },
        }));
        const results = await Promise.allSettled(requests.map(request =>
            this.requestAgent(
                request.agentName,
                'start-contest-recording',
                request.options
            )
        ));

        // Every camera is a full offscreen renderer, so a whole roster starting
        // at once can push a bot past the request timeout. Losing an angle costs
        // footage, not the match: keep the angles that came up and let the caller
        // report the rest. Aborting here used to strand a prepared arena full of
        // bots that had not been told to play yet.
        const failures = [];
        const recorded = [];
        results.forEach((result, index) => {
            const { agentName, options } = requests[index];
            if (result.status === 'rejected') {
                failures.push({
                    agentName,
                    error: String(result.reason?.message || result.reason),
                });
                return;
            }
            if (!result.value?.success) {
                failures.push({
                    agentName,
                    error: String(result.value?.error || 'recording failed'),
                });
                return;
            }
            recorded.push({ agentName, cameraCount: 1 + options.externalCameras.length });
        });

        // A bot that failed part way through can still have live recorders, and
        // it is no longer in the session we would stop later. Release it now
        // without making the match wait on another round trip.
        for (const failure of failures) {
            Promise.resolve()
                .then(() => this.requestAgent(failure.agentName, 'stop-contest-recording'))
                .catch(() => { /* the angle is already lost */ });
        }

        this.active = {
            sessionId,
            contestId,
            syncEpochMs,
            participants: recorded.map(entry => entry.agentName),
            requestedParticipants: [...participants],
            observer: recorded.some(entry => entry.agentName === observer) ? observer : null,
            cameraCount: recorded.reduce((total, entry) => total + entry.cameraCount, 0),
            failures,
        };
        return { ...this.active };
    }

    async stop(contestId = null) {
        if (!this.active) return null;
        if (contestId && this.active.contestId !== contestId) return null;

        const session = this.active;
        this.active = null;
        const results = await Promise.allSettled(session.participants.map(agentName =>
            this.requestAgent(agentName, 'stop-contest-recording')
        ));
        const failures = results.flatMap((result, index) => {
            if (result.status === 'rejected') {
                return [`${session.participants[index]}: ${result.reason?.message || result.reason}`];
            }
            if (!result.value?.success) {
                return [`${session.participants[index]}: ${result.value?.error || 'stop failed'}`];
            }
            return [];
        });
        if (failures.length) {
            console.warn(`Contest recording stop was incomplete: ${failures.join('; ')}`);
        }
        return { ...session, stopFailures: failures };
    }
}

export { overviewCameras, participantWideCamera };
