// The shell scenario: a console whose local runtime is not what a person thinks.
//
// Every other scenario here scripts a SESSION. This one scripts the shell around
// one, because the chapter of the design it exists for — the frame's honest chrome —
// is silent in a healthy console by construction: a connected shell with an OS-local
// transport and a working keystore renders no chip colour, no banner, and no notice,
// so a scenario in that state would show a person an empty frame and prove nothing.
//
// SO IT OPENS DEGRADED, AND THAT IS THE DECISION THIS FILE MAKES. The frozen clock
// only moves when a driver advances it, so what a person sees when they pick this
// scenario from the switcher is the frame at tick 0 — which is why the reconnect
// ladder, the loopback fallback, and the unusable keystore are all standing there,
// rather than at a later tick a browser tier would have to reach. The two later
// frames are for the tiers: a handshake the daemon refuses, and then the quiet state,
// so the whole ladder is reachable in one script.
//
// THE BEATS ARE THE STREAM'S CLOCK. The shell feed wakes on the engine's own beat
// subscription — the fixture has no timer and the design forbids one — so every
// shell frame below sits on a tick a beat is also due at.
//
// WHAT IT DELIBERATELY DOES NOT SCRIPT. No settings page reads, no agents, no runs.
// A scenario that filled those in would make this one a second flagship; what it is
// for is the frame.

import type { ConsoleScenario } from "../scenario-runtime/index.js";

export const SHELL_SCENARIO_ID = "shell";

const SESSION_ID = "019b78d1-2c00-75e5-8510-ada11a5a3301";
const PARTICIPANT_YOU = "019b78d1-2c00-79a4-8110-cca0117a3302";
const NODE_ID = "workstation-1";

/** The instant the frozen clock reports at tick zero. */
const STARTED_AT = "2026-01-01T10:00:00.000Z";

/**
 * A stamp `atMs` after the start, composed rather than computed.
 *
 * The neighbours next door do the same, and the reason is the console's own rule
 * about reading stamps: arithmetic through `Date` would put a host's timezone and its
 * day-normalisation between a scenario's declared tick and the string a surface
 * renders. Every tick in this file is under a second, so the milliseconds field is
 * the whole of what moves.
 */
function occurredAt(atMs: number): string {
  return `2026-01-01T10:00:00.${String(atMs).padStart(3, "0")}Z`;
}

export const SHELL_SCENARIO: ConsoleScenario = {
  id: SHELL_SCENARIO_ID,
  label: "Shell degraded",
  purpose:
    "A window whose local runtime is reconnecting, whose transport fell back to loopback, and whose host has no usable keystore — the state the frame's honest chrome is designed against, standing at tick zero so it is what the switcher shows. Advancing reaches a refused handshake and then the quiet connected state.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: [PARTICIPANT_YOU],
  viewingParticipantId: PARTICIPANT_YOU,
  membershipRoleByParticipantId: { [PARTICIPANT_YOU]: "owner" },
  startedAtIso: STARTED_AT,
  // Three frames on three beat ticks. `store/shell-state.ts` owns every word in them.
  shellStatus: [
    {
      atMs: 0,
      report: {
        connection: { kind: "reconnecting", attempt: 2, attemptLimit: 5 },
        // The handshake that HAD succeeded before the drop, kept: the daemon page
        // names the version a runtime speaks, and a reconnecting window has not
        // forgotten which one it was talking to.
        negotiation: {
          compatible: true,
          daemonProtocolVersion: "2026-04-30",
          consoleProtocolVersion: "2026-08-14",
          daemonSupportedProtocols: ["2026-04-30", "2026-05-28"],
          reason: undefined,
        },
        lastHeartbeatAt: occurredAt(0),
        // Both notices standing at once, which is one of the four states
        // §Loopback and keystore notices enumerates and the only one in which a
        // surface can be caught rendering them as one line.
        transport: "loopback",
        keystore: "unavailable",
      },
    },
    {
      atMs: 400,
      report: {
        connection: { kind: "version-incompatible" },
        // The daemon's chosen version and this build's proposal, both verbatim.
        // `version.ceiling_exceeded` is the arm where the RUNTIME is what moves.
        negotiation: {
          compatible: false,
          daemonProtocolVersion: "2026-04-30",
          consoleProtocolVersion: "2026-08-14",
          daemonSupportedProtocols: ["2026-04-30", "2026-05-28"],
          reason: "version.ceiling_exceeded",
        },
        lastHeartbeatAt: occurredAt(400),
        transport: "loopback",
        keystore: "unavailable",
      },
    },
    {
      atMs: 800,
      report: {
        connection: { kind: "connected" },
        negotiation: {
          compatible: true,
          daemonProtocolVersion: "2026-04-30",
          consoleProtocolVersion: "2026-08-14",
          daemonSupportedProtocols: ["2026-04-30", "2026-05-28"],
          reason: undefined,
        },
        lastHeartbeatAt: occurredAt(800),
        transport: "os-local",
        keystore: "available",
      },
    },
  ],
  beats: [
    {
      atMs: 0,
      event: {
        id: "019b78d1-2c00-7ea1-8110-e5e0d1153301",
        sessionId: SESSION_ID,
        sequence: 1,
        kind: "session.created",
        occurredAt: occurredAt(0),
        actorId: PARTICIPANT_YOU,
        payload: { sessionId: SESSION_ID, config: {}, metadata: {} },
      },
    },
    {
      atMs: 400,
      event: {
        id: "019b78d1-2c00-7ea1-8110-e5e0d1153302",
        sessionId: SESSION_ID,
        sequence: 2,
        kind: "runtime_node.registered",
        occurredAt: occurredAt(400),
        actorId: PARTICIPANT_YOU,
        payload: {
          sessionId: SESSION_ID,
          nodeId: NODE_ID,
          newState: "registering",
          capabilities: { "provider-driver": { available: true } },
          nodeVersion: "1.4.2",
          platform: "darwin-arm64",
        },
      },
    },
    {
      atMs: 800,
      event: {
        id: "019b78d1-2c00-7ea1-8110-e5e0d1153303",
        sessionId: SESSION_ID,
        sequence: 3,
        kind: "runtime_node.online",
        occurredAt: occurredAt(800),
        payload: {
          sessionId: SESSION_ID,
          nodeId: NODE_ID,
          previousState: "registering",
          newState: "online",
        },
      },
    },
  ],
  replies: [
    {
      call: "session.read",
      result: {
        session: {
          id: SESSION_ID,
          state: "active",
          config: {},
          metadata: {},
          createdAt: STARTED_AT,
          updatedAt: STARTED_AT,
        },
        timelineCursors: { latest: "shell-cursor-1" },
      },
    },
    { call: "agent.list", result: { agents: [] } },
  ],
};
