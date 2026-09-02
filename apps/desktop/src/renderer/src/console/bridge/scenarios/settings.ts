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
// broken and be wrong both ways.

import type {
  EventEnvelopeVersion,
  NodeId,
  ParticipantId,
  RuntimeNodeRosterEntry,
} from "@ai-sidekicks/contracts";

import type { ConsoleScenario, ScenarioRuntimeNodeRosterFrame } from "../scenario.js";

export const SETTINGS_SCENARIO_ID = "settings";

// Wire identifiers, spelled as the wire spells them — UUID v7 values whose leading
// bytes are this scenario's own start instant, so a rendered id still tells one
// fixture apart from another. The node ids are the exception above.
//
// The three the ROSTER read carries are branded at their declaration rather than at
// each of the four rows that use them: `RuntimeNodeRosterEntry` types `nodeId`,
// `participantId`, and `clientVersion` as brands, an event payload types every
// member `unknown`, and one assertion per constant is what keeps the rows free of
// them. The assertion is a claim, and the bridge seam's test discharges it by parsing
// every shipped frame with the registered `RuntimeNodeRosterResponseSchema`.
const SESSION_ID = "019b7892-1c00-75e5-8510-ada11a5a55a5";
const PARTICIPANT_YOU = "019b7892-1c00-79a4-8110-cca0117a0550" as ParticipantId;
const NODE_WORKSTATION = "node-workstation" as NodeId;
const NODE_BUILDER = "node-builder" as NodeId;

// The MAJOR.MINOR wire-contract version each daemon reported at attach, which is
// what the below-floor verdict is derived from — deliberately NOT the node's
// software release version (`nodeVersion` on the table below, a bounded free string
// that carries a patch segment this brand's pattern rejects outright).
const CLIENT_VERSION_CURRENT = "1.4" as EventEnvelopeVersion;
const CLIENT_VERSION_BELOW_FLOOR = "1.3" as EventEnvelopeVersion;

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
    registrationEventId: "019b7892-1c00-7ea1-8120-cca0117a0552",
    declarationEventId: "019b7892-1c00-7ea1-8140-cca0117a0554",
    arrivalEventId: "019b7892-1c00-7ea1-8160-cca0117a0556",
    nodeVersion: "1.4.2",
    // Composite `platform+arch` values are exactly what this bounded free string is
    // for; it is deliberately not an enum, because no source enumerates the set.
    platform: "darwin-arm64",
    capability: "provider-driver",
    registeredAtMs: 40,
    onlineAtMs: 120,
    degradesAtMs: undefined,
    degradeEventId: undefined,
  },
  {
    nodeId: NODE_BUILDER,
    registrationEventId: "019b7892-1c00-7ea1-8130-cca0117a0553",
    declarationEventId: "019b7892-1c00-7ea1-8150-cca0117a0555",
    arrivalEventId: "019b7892-1c00-7ea1-8170-cca0117a0557",
    degradeEventId: "019b7892-1c00-7ea1-8180-cca0117a0558",
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

/** One row of the table above, so the degrade beat can name what it narrows to. */
type SettingsRuntimeNode = (typeof RUNTIME_NODES)[number];

/** The instant a millisecond offset lands on, as the frozen clock reports it. */
function occurredAt(offsetMs: number): string {
  return `2026-01-01T08:00:00.${String(offsetMs).padStart(3, "0")}Z`;
}

/**
 * One roster row, with the members both machines here share already filled in.
 *
 * A factory rather than four hand-written literals, on the same rule the node table
 * above states: the two frames below are two READINGS of the same two machines, and
 * a hand-copied `participantId` or `capabilities` map is exactly where two readings
 * of one machine drift with nothing to catch it. What varies between readings is
 * what the caller passes — the two health axes and the heartbeat that moves with
 * them — so the parameter list is the list of things this scenario is actually
 * saying changed.
 */
function rosterRow(fields: {
  readonly nodeId: NodeId;
  readonly clientVersion: EventEnvelopeVersion;
  readonly capability: string;
  readonly attachedAtMs: number;
  readonly state: RuntimeNodeRosterEntry["state"];
  readonly healthState: RuntimeNodeRosterEntry["healthState"];
  readonly lastHeartbeatAtMs: number | null;
}): RuntimeNodeRosterEntry {
  return {
    nodeId: fields.nodeId,
    // One participant owns both machines here, which is the ordinary case: a person
    // attaches their laptop and their build box to the same session.
    participantId: PARTICIPANT_YOU,
    state: fields.state,
    healthState: fields.healthState,
    lastHeartbeatAt:
      fields.lastHeartbeatAtMs === null ? null : occurredAt(fields.lastHeartbeatAtMs),
    // DERIVED at read time from `clientVersion` against the session floor, and the
    // roster is where that verdict is legible at all: no event carries it. A
    // below-floor node is admitted read-only and stays in the set — the roster hides
    // nobody, which is the property the page must never be built to break.
    readOnly: fields.clientVersion === CLIENT_VERSION_BELOW_FLOOR,
    capabilities: { [fields.capability]: { available: true } },
    clientVersion: fields.clientVersion,
    attachedAt: occurredAt(fields.attachedAtMs),
  };
}

/**
 * The roster as the registered read answers it, at the four ticks it changes.
 *
 * Frame 0 is EMPTY and that is a reading rather than an absence: at tick zero the
 * session exists and no machine has attached to it yet, which the registered
 * response admits explicitly and which the page has to draw. A scenario that opened
 * with its first populated frame would leave the read refusing until 160ms and make
 * the empty roster unreachable from any tick at all.
 *
 * Frame 320 is the one this scenario exists for. The builder's SLOT axis degrades —
 * the same transition the `runtime_node.degraded` beat announces at that tick — while
 * its LIVENESS axis recovers from `degraded` to `online`, because a heartbeat landed
 * just before. The two axes have different owners and are not reconciled anywhere on
 * the wire, so a page that renders one collapsed health scalar has to pick which of
 * these two true readings to report and is wrong whichever it picks.
 */
const RUNTIME_NODE_ROSTER_FRAMES: readonly ScenarioRuntimeNodeRosterFrame[] = [
  { atMs: 0, nodes: [] },
  {
    // Both machines admitted, neither one heartbeating yet. `healthState` and
    // `lastHeartbeatAt` are NULL together here, which is not a gap in the script:
    // the read LEFT-JOINs presence on the attachment, and no presence row exists
    // before a machine's first beat. It is the only reading in which the liveness
    // axis has nothing to say, and a page that rendered it as "offline" would be
    // reporting a verdict the sweep has not reached.
    atMs: 60,
    nodes: [
      rosterRow({
        nodeId: NODE_WORKSTATION,
        clientVersion: CLIENT_VERSION_CURRENT,
        capability: "provider-driver",
        attachedAtMs: 40,
        state: "registering",
        healthState: null,
        lastHeartbeatAtMs: null,
      }),
      rosterRow({
        nodeId: NODE_BUILDER,
        clientVersion: CLIENT_VERSION_BELOW_FLOOR,
        capability: "provider-driver",
        attachedAtMs: 60,
        state: "registering",
        healthState: null,
        lastHeartbeatAtMs: null,
      }),
    ],
  },
  {
    atMs: 160,
    nodes: [
      rosterRow({
        nodeId: NODE_WORKSTATION,
        clientVersion: CLIENT_VERSION_CURRENT,
        capability: "provider-driver",
        attachedAtMs: 40,
        state: "online",
        healthState: "online",
        lastHeartbeatAtMs: 150,
      }),
      rosterRow({
        nodeId: NODE_BUILDER,
        clientVersion: CLIENT_VERSION_BELOW_FLOOR,
        capability: "provider-driver",
        attachedAtMs: 60,
        state: "online",
        // Late already, on the axis the sweep owns, while its slot is still online:
        // the disagreement starts here rather than at 320, so the page has a frame
        // where the two axes differ and a frame where they differ the other way.
        healthState: "degraded",
        lastHeartbeatAtMs: 90,
      }),
    ],
  },
  {
    atMs: 320,
    nodes: [
      rosterRow({
        nodeId: NODE_WORKSTATION,
        clientVersion: CLIENT_VERSION_CURRENT,
        capability: "provider-driver",
        attachedAtMs: 40,
        state: "online",
        healthState: "online",
        lastHeartbeatAtMs: 310,
      }),
      rosterRow({
        nodeId: NODE_BUILDER,
        clientVersion: CLIENT_VERSION_BELOW_FLOOR,
        capability: "provider-driver",
        attachedAtMs: 60,
        state: "degraded",
        healthState: "online",
        lastHeartbeatAtMs: 315,
      }),
    ],
  },
];

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
    ...RUNTIME_NODES.filter(
      (node): node is Extract<SettingsRuntimeNode, { degradesAtMs: number }> =>
        node.degradesAtMs !== undefined,
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
