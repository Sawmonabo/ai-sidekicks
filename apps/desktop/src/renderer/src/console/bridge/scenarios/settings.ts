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
//
// AND THE ROSTER ITSELF, WHICH THE BEATS ARE NOT. A `runtime_node.*` beat says WHEN
// a machine changed; the registered `runtimenode.roster` read says WHAT the set now
// is, and the two carry different axes — the beats carry the slot state, and only
// the read carries the sweep-owned `healthState` / `lastHeartbeatAt` pair and the
// derived below-floor `readOnly` verdict. So the roster is scripted as FRAMES on the
// frozen clock beside the beats, and the tick that matters is 320: one axis
// DEGRADES there while the other RECOVERS. That disagreement is the whole reason
// the page renders both and collapses neither — a machine whose attachment slipped
// into the reversible band at the same moment its heartbeat came back is a real
// state, and a page showing one health scalar would report it as either fine or

import type { ConsoleScenario } from "../scenario-runtime/index.js";
import {
  PARTICIPANT_YOU,
  RUNTIME_NODES,
  RUNTIME_NODE_ROSTER_FRAMES,
  SESSION_ID,
  occurredAt,
  type SettingsRuntimeNode,
} from "./settings-runtime-nodes.js";

export const SETTINGS_SCENARIO_ID = "settings";

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
  // The viewer is an owner, which is what lets this scenario drive the role-gated
  // controls the settings surfaces put behind one: the identity read answers
  // `PARTICIPANT_YOU`, and the role a surface gates on is this entry, looked up in
  // the roster the session read establishes.
  membershipRoleByParticipantId: { [PARTICIPANT_YOU]: "owner" },
  startedAtIso: "2026-01-01T08:00:00.000Z",
  runtimeNodeRoster: RUNTIME_NODE_ROSTER_FRAMES,
  beats: [
    {
      atMs: 0,
      event: {
        id: "019b7892-1c00-7ea1-8110-cca0117a0551",
        sessionId: SESSION_ID,
        sequence: 1,
        kind: "session.created",
        occurredAt: occurredAt(0),
        actorId: PARTICIPANT_YOU,
        payload: { sessionId: SESSION_ID, config: {}, metadata: {} },
      },
    },
    ...RUNTIME_NODES.map((node, nodeIndex) => ({
      atMs: node.registeredAtMs,
      event: {
        id: node.registrationEventId,
        sessionId: SESSION_ID,
        sequence: 2 + nodeIndex,
        kind: "runtime_node.registered",
        occurredAt: occurredAt(node.registeredAtMs),
        // The node's owning participant acted; the daemon did not decide to admit a
        // machine on its own.
        actorId: PARTICIPANT_YOU,
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
        id: node.declarationEventId,
        sessionId: SESSION_ID,
        sequence: 4 + nodeIndex,
        kind: "runtime_node.capability_declared",
        occurredAt: occurredAt(node.registeredAtMs + 20),
        actorId: PARTICIPANT_YOU,
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
        id: node.arrivalEventId,
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
    // Both members are required together: a node that degrades has an instant and an
    // event id, and a row carrying one without the other would emit a beat with an
    // undefined id rather than failing here where the table is written.
    ...RUNTIME_NODES.filter(
      (
        node,
      ): node is SettingsRuntimeNode & {
        readonly degradesAtMs: number;
        readonly degradeEventId: string;
      } => node.degradesAtMs !== undefined && node.degradeEventId !== undefined,
    ).map((node) => ({
      atMs: node.degradesAtMs,
      event: {
        id: node.degradeEventId,
        sessionId: SESSION_ID,
        sequence: 8,
        kind: "runtime_node.degraded",
        occurredAt: occurredAt(node.degradesAtMs),
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
