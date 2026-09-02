// The settings scenario — one healthy node, one that degraded.
//
// The settings surface is the one destination whose content is almost entirely NOT
// session state: it reads node health, shell preferences, provider accounts, and
// server governance. Almost every one of those wires is unregistered today, so this
// scenario scripts almost nothing on purpose. Its job is to put the console in a
// state where the settings rail is reachable and every page whose wire is missing is
// answering from the growth port's refusal rather than from scripted data — which is
// exactly what the shipped build does, and therefore the state those pages must be
// designed against.
//
// A scenario that filled those pages with plausible-looking rows would make the
// fixture disagree with the application in the one direction that matters: the
// screenshots would show a working settings surface that nobody can reach.
//
// THE ONE THING IT DOES SCRIPT IS NODE HEALTH, BECAUSE THAT ONE IS ON THE WIRE.
// `runtime_node.*` is the exception: seven types are in the census and five of them
// carry registered `SessionEventSchema` payload variants
// (`packages/contracts/src/runtime-node.ts`), so a node coming up and a node falling
// into the degraded band are both scriptable without inventing anything. Two nodes
// run here for a reason the page states in its own words: the two health axes have
// different owners and a recovery on one must never mask a degradation on the other,
// which is only legible when one node is fine and another is not at the same moment.
//
// WHY `degraded` CARRIES A HAND-SHAPED PAYLOAD AND `online` DOES NOT. Five of the
// seven types register a variant; `runtime_node.degraded` and `runtime_node.revoked`
// are deliberately census members with none, because both are server-derived and
// V1.1-gated. So this file's `degraded` beat is held to the census leg alone, and it
// carries the SAME base members the four registered lifecycle variants share rather
// than a shape of its own — the honest reading of an event whose payload contract is
// stated in `Spec-006` and not yet registered here.
//
// WHY THE NODE IDENTIFIERS ARE NOT UUIDs. `NodeIdSchema` is a bounded branded STRING
// and not a UUID (`packages/contracts/src/node-id.ts`), unlike every session,
// participant, membership, and agent id in these scenarios. So the readable names
// below are what the strict layer actually accepts, and spelling them as UUIDs would
// misreport the one identifier on this wire that is not one.
//
// WHAT THE NODES PAGE DOES WITH THESE BEATS, AND WHAT IT DOES NOT. The page absorbs
// the shipped attach roster, which reads the installed bridge directly rather than
// the one the console resolved, so these beats reach the console's own store and not
// that component's table. They are scripted anyway because the store, the session
// partition, and every surface that folds runtime-node lifecycle are driven from
// them — and because the day that roster takes a console bridge, the scenario it
// needs is already here.

import type { ConsoleScenario } from "../scenario.js";

export const SETTINGS_SCENARIO_ID = "settings";

// Wire identifiers, spelled as the wire spells them — UUID v7 values whose leading
// bytes are this scenario's own start instant, so a rendered id still tells one
// fixture apart from another. The node ids are the exception above.
const SESSION_ID = "019b7892-1c00-75e5-8510-ada11a5a55a5";
const PARTICIPANT_YOU = "019b7892-1c00-79a4-8110-cca0117a0550";
const NODE_WORKSTATION = "node-workstation";
const NODE_BUILDER = "node-builder";

/**
 * The two machines, and the health story each one tells.
 *
 * One table rather than four literals per node, on `flagship.ts`'s rule: a node's
 * registration, its capability declaration, and its lifecycle transitions are views
 * of one machine, and hand-written copies of one machine drift where nothing catches
 * it. `degradesAtMs` is what separates the two stories — absent means the node came
 * up and stayed up.
 */
const RUNTIME_NODES = [
  {
    nodeId: NODE_WORKSTATION,
    nodeVersion: "1.4.2",
    // Composite `platform+arch` values are exactly what this bounded free string is
    // for; it is deliberately not an enum, because no source enumerates the set.
    platform: "darwin-arm64",
    capability: "provider-driver",
    registeredAtMs: 40,
    onlineAtMs: 120,
    degradesAtMs: undefined,
  },
  {
    nodeId: NODE_BUILDER,
    nodeVersion: "1.3.9",
    platform: "linux-x64",
    capability: "provider-driver",
    registeredAtMs: 60,
    onlineAtMs: 160,
    // The heartbeat sweep's reversible hysteresis band. It is NOT `offline`: a node
    // in this band is expected back, and collapsing the two would tell an operator a
    // machine is gone when it is merely late.
    degradesAtMs: 320,
  },
] as const;

/** The instant a millisecond offset lands on, as the frozen clock reports it. */
function occurredAt(offsetMs: number): string {
  return `2026-01-01T08:00:00.${String(offsetMs).padStart(3, "0")}Z`;
}

export const SETTINGS_SCENARIO: ConsoleScenario = {
  id: SETTINGS_SCENARIO_ID,
  label: "Settings, one node degraded",
  purpose:
    "One quiet session so the rail is reachable, two runtime nodes of which one falls into the degraded band, and every settings page whose wire is unregistered answering from the growth port's refusal — the state the shipped build is in.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: [PARTICIPANT_YOU],
  // The only participant, and stated rather than inferred all the same: a
  // single-member roster makes the head of the join order coincide with the viewer,
  // and a surface that read the coincidence as the rule would be wrong everywhere
  // else.
  viewingParticipantId: PARTICIPANT_YOU,
  startedAtIso: "2026-01-01T08:00:00.000Z",
  beats: [
    {
      atMs: 0,
      event: {
        sessionId: SESSION_ID,
        sequence: 1,
        kind: "session.created",
        occurredAt: occurredAt(0),
        actorParticipantId: PARTICIPANT_YOU,
        payload: { sessionId: SESSION_ID, config: {}, metadata: {} },
      },
    },
    ...RUNTIME_NODES.map((node, nodeIndex) => ({
      atMs: node.registeredAtMs,
      event: {
        sessionId: SESSION_ID,
        sequence: 2 + nodeIndex,
        kind: "runtime_node.registered",
        occurredAt: occurredAt(node.registeredAtMs),
        // The node's owning participant acted; the daemon did not decide to admit a
        // machine on its own.
        actorParticipantId: PARTICIPANT_YOU,
        // The registered shape, verbatim: the lifecycle base plus the three members
        // registration adds. `newState` is `registering` and there is no
        // `previousState`, because a node being admitted has no state it came from.
        payload: {
          sessionId: SESSION_ID,
          nodeId: node.nodeId,
          newState: "registering",
          capabilities: { [node.capability]: { available: true } },
          nodeVersion: node.nodeVersion,
          platform: node.platform,
        },
      },
    })),
    ...RUNTIME_NODES.map((node, nodeIndex) => ({
      atMs: node.registeredAtMs + 20,
      event: {
        sessionId: SESSION_ID,
        sequence: 4 + nodeIndex,
        kind: "runtime_node.capability_declared",
        occurredAt: occurredAt(node.registeredAtMs + 20),
        actorParticipantId: PARTICIPANT_YOU,
        // The REDUCED base — no `previousState` / `newState` at all. A capability
        // declaration is not a node-state transition, and the registered shape says
        // so by leaving both members off.
        payload: {
          sessionId: SESSION_ID,
          nodeId: node.nodeId,
          capability: node.capability,
          capabilityDetails: { available: true },
        },
      },
    })),
    ...RUNTIME_NODES.map((node, nodeIndex) => ({
      atMs: node.onlineAtMs,
      event: {
        sessionId: SESSION_ID,
        sequence: 6 + nodeIndex,
        kind: "runtime_node.online",
        occurredAt: occurredAt(node.onlineAtMs),
        // No actor. The daemon moves a node online once its capability declaration
        // has been accepted, and naming a participant would attribute a system
        // transition to a person.
        payload: {
          sessionId: SESSION_ID,
          nodeId: node.nodeId,
          previousState: "registering",
          newState: "online",
        },
      },
    })),
    ...RUNTIME_NODES.filter((node) => node.degradesAtMs !== undefined).map((node) => ({
      atMs: node.degradesAtMs ?? 0,
      event: {
        sessionId: SESSION_ID,
        sequence: 8,
        kind: "runtime_node.degraded",
        occurredAt: occurredAt(node.degradesAtMs ?? 0),
        payload: {
          sessionId: SESSION_ID,
          nodeId: node.nodeId,
          previousState: "online",
          newState: "degraded",
        },
      },
    })),
  ],
  replies: [
    // No agent has been attached to this session, and the empty list is the honest
    // reading rather than an absent reply: the read succeeded and there is nothing
    // in it. Every other settings read this console makes is unregistered on the
    // wire, so nothing else is scripted and each of those pages renders the refusal.
    { call: "agent.list", result: { agents: [] } },
  ],
};
