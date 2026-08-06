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
        const failures = results.flatMap((result, index) => {
            if (result.status === 'rejected') {
                return [`${requests[index].agentName}: ${result.reason?.message || result.reason}`];
            }
            if (!result.value?.success) {
                return [`${requests[index].agentName}: ${result.value?.error || 'recording failed'}`];
            }
            return [];
        });
        if (failures.length) {
            await Promise.allSettled(participants.map(agentName =>
                this.requestAgent(agentName, 'stop-contest-recording')
            ));
            throw new Error(`Could not record every contest angle (${failures.join('; ')})`);
        }

        this.active = {
            sessionId,
            contestId,
            syncEpochMs,
            participants: [...participants],
            observer,
            cameraCount: participants.length * 2 + 2,
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
