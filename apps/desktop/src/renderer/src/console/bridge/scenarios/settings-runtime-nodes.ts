// The runtime-node roster the settings scenario serves, frame by frame.
//
// Split out of `settings.ts` because a scenario and the wire it scripts are two
// subjects: that module says what a person does and in what order, and this says
// what the daemon answers while they do it. The frames are a data table, and a data
// table sitting between a scenario's identity and its beats is what made the file
// unreadable from either end.
//
// EVERY FRAME IS A WHOLE REGISTERED RESPONSE. The bridge seam parses each one with
// the registered `RuntimeNodeRosterResponseSchema`, so a frame that drifted from the
// contract fails there rather than rendering as a shape no daemon would send.

import type {
  EventEnvelopeVersion,
  NodeId,
  ParticipantId,
  RuntimeNodeAttachResponse,
  RuntimeNodeRosterEntry,
} from "@ai-sidekicks/contracts";

import type { RuntimeNodeAttachDraft } from "../../../runtime-node-attach/index.js";
import type { ScenarioReply, ScenarioRuntimeNodeRosterFrame } from "../scenario-runtime/index.js";

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
export const SESSION_ID = "019b7892-1c00-75e5-8510-ada11a5a55a5";
export const PARTICIPANT_YOU = "019b7892-1c00-79a4-8110-cca0117a0550" as ParticipantId;
const NODE_WORKSTATION = "node-workstation" as NodeId;
const NODE_BUILDER = "node-builder" as NodeId;
// The machine the attach control is offered FOR, and it is deliberately not one of
// the two above: an attach is a machine arriving, so pointing the declaration at a
// node already in the roster would script a control whose success changes nothing a
// reader can see.
const NODE_LAPTOP = "node-laptop" as NodeId;

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
export interface SettingsRuntimeNode {
  readonly nodeId: NodeId;
  readonly registrationEventId: string;
  readonly declarationEventId: string;
  readonly arrivalEventId: string;
  readonly degradeEventId?: string | undefined;
  readonly nodeVersion: string;
  /** A composite `platform+arch` value. Bounded free text, deliberately not an enum. */
  readonly platform: string;
  readonly capability: string;
  readonly registeredAtMs: number;
  readonly onlineAtMs: number;
  /** Absent means the node came up and stayed up. */
  readonly degradesAtMs?: number | undefined;
}

export const RUNTIME_NODES: readonly SettingsRuntimeNode[] = [
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
];

/** The instant a millisecond offset lands on, as the frozen clock reports it. */
export function occurredAt(offsetMs: number): string {
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
 *
 * `controlHolder` carries both of its readings across the four frames. Nobody holds
 * the session's shared shell while the machines are still registering, and this
 * participant holds it from 160 on — so the page renders an advertised holder and a
 * free lease without a scenario swap. A `null` here is deliberately undecomposable:
 * a free lease and a holder suppressed behind an offline producer arrive the same
 * way, and no client is entitled to tell them apart.
 */
export const RUNTIME_NODE_ROSTER_FRAMES: readonly ScenarioRuntimeNodeRosterFrame[] = [
  { atMs: 0, nodes: [], controlHolder: null },
  {
    // Both machines admitted, neither one heartbeating yet. `healthState` and
    // `lastHeartbeatAt` are NULL together here, which is not a gap in the script:
    // the read LEFT-JOINs presence on the attachment, and no presence row exists
    // before a machine's first beat. It is the only reading in which the liveness
    // axis has nothing to say, and a page that rendered it as "offline" would be
    // reporting a verdict the sweep has not reached.
    atMs: 60,
    controlHolder: null,
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
    controlHolder: PARTICIPANT_YOU,
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
    controlHolder: PARTICIPANT_YOU,
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

/**
 * The declaration a third machine makes about itself, for the attach control to review.
 *
 * A NODE'S OWN CLAIM, AND THE FIXTURE IS STANDING IN FOR THE PROCESS THAT MAKES IT.
 * `Spec-023 §Trust Stance` puts the composition of an attach draft in the main
 * process, off the node registry, because identity, contract version, health, and
 * capability set are things a machine asserts and a renderer may not assert on its
 * behalf. So the console resolves this and composes nothing: the deck supplies it the
 * way the deck supplies every other reading, and under the live bridge no read
 * delivers one and the mount says so.
 *
 * It reports `online` at a CURRENT contract version, which is what makes the control
 * worth rendering here: the roster beside it already carries a below-floor machine
 * admitted read-only, so the page shows the admitted-not-ejected rule and an ordinary
 * arrival in one view.
 */
export const SETTINGS_RUNTIME_NODE_ATTACH_DRAFT: RuntimeNodeAttachDraft = {
  participantId: PARTICIPANT_YOU,
  nodeId: NODE_LAPTOP,
  clientVersion: CLIENT_VERSION_CURRENT,
  // The same one-capability shape the roster rows carry, and typed `unknown` on the
  // wire for the same reason: no source enumerates what a node may declare.
  capabilities: { "provider-driver": { available: true } },
  healthState: "online",
};

/** What the daemon answers that attach with, at the registered response shape. */
const SETTINGS_RUNTIME_NODE_ATTACH_RESPONSE: RuntimeNodeAttachResponse = {
  attachmentId: "019b7892-1c00-7ea1-8190-cca0117a0559",
  // `registering` and not `online`: the attach records the machine, and the liveness
  // axis is the sweep's to answer once a heartbeat lands. A fixture that answered
  // `online` here would teach the flow that attaching proves a node is up.
  state: "registering",
  // The permission axis, derived from the declared contract version against the
  // session floor. This machine reports the current version, so it is admitted with
  // the session's full write surface.
  readOnly: false,
  attachedAt: occurredAt(420),
};

/**
 * The attach reply this scenario scripts, on a latency a person can watch.
 *
 * `afterMs` is what makes the flow's pending arm reachable at all: an attach that
 * settled in the same tick it was issued would leave the in-flight state unrendered
 * in the whole deck, and that state is the one a slow control plane spends the most
 * time in.
 */
export const SETTINGS_RUNTIME_NODE_ATTACH_REPLY: ScenarioReply = {
  call: "runtimenode.attach",
  afterMs: 60,
  result: SETTINGS_RUNTIME_NODE_ATTACH_RESPONSE,
};
