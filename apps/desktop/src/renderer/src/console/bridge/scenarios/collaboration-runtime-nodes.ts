// The machines in the collaboration room — the second job `collaboration.ts` was
// doing.
//
// A room with people in it is a room with their MACHINES in it, and the two are
// genuinely different scripts: the people arrive as memberships and presence and
// are read back through `presence.read`, while the machines arrive as
// `runtime_node.*` lifecycle beats and are read back through the registered
// `runtimenode.roster` query. They share only the session and who owns what, which
// is exactly what this module takes as a parameter — so the two scripts live in two
// files and neither imports the other's identifiers.
//
// WHY THE TWO SURFACES CARRY DIFFERENT AXES, WHICH IS THE WHOLE POINT. A beat
// announces the SLOT transition (`runtime_node_attachments.state`) and nothing
// else. The roster read carries that same slot axis PLUS the sweep-owned liveness
// pair (`healthState`, `lastHeartbeatAt`) and the read-time below-floor `readOnly`
// verdict, none of which any event carries. So a scenario that scripted only beats
// could never put a surface in the state the never-mask rule exists for: two health
// axes, different owners, disagreeing. Frame 640 below is that state.
//
// THE DEPARTURE IS EXPLICIT, NOT LOST. `explicit_shutdown` is the one
// `runtime_node.offline` reason a V1 daemon authors — `heartbeat_lost` and
// `network_partition` are server-derived and V1.1-gated — so it is the only
// departure a fixture can script without inventing a producer for it.

import type {
  EventEnvelopeVersion,
  NodeId,
  ParticipantId,
  RuntimeNodeRosterEntry,
} from "@ai-sidekicks/contracts";

import type { ScenarioBeat, ScenarioRuntimeNodeRosterFrame } from "../scenario-runtime/index.js";

// The node identifiers are NOT UUIDs, unlike every other id in this scenario:
// `NodeId` is a bounded branded STRING, so a readable machine name is what the wire
// actually accepts and spelling one as a UUID would misreport the one identifier on
// this wire that is not one.
const NODE_LAPTOP = "node-sawyer-laptop" as NodeId;
const NODE_DESKTOP = "node-priya-desktop" as NodeId;
const NODE_RUNNER = "node-tomas-runner" as NodeId;

// The MAJOR.MINOR wire-contract version each daemon reported at attach, which the
// below-floor `readOnly` verdict is derived from — deliberately NOT a node's
// software release version, which carries a patch segment this brand rejects
// outright. Branded at the declaration because the roster entry types the member as
// a brand while an event payload types every member `unknown`; the assertion is a
// claim, and the bridge seam's test discharges it by parsing every shipped frame
// with the registered `RuntimeNodeRosterResponseSchema`.
const CLIENT_VERSION_CURRENT = "1.4" as EventEnvelopeVersion;
const CLIENT_VERSION_BELOW_FLOOR = "1.2" as EventEnvelopeVersion;

/** What this script needs from the scenario it is spliced into. */
export interface CollaborationRuntimeNodeScript {
  /** The session every machine here attaches to. */
  readonly sessionId: string;
  /**
   * Who owns each machine, in the order the machines register.
   *
   * A fixed-arity tuple rather than an array, so a caller that passes two owners for
   * three machines fails to compile instead of leaving one machine attributed to
   * `undefined` — which would render as a node nobody in the room owns.
   */
  readonly ownerParticipantIds: readonly [ParticipantId, ParticipantId, ParticipantId];
  /** The first free position in the scenario's event log. */
  readonly firstSequence: number;
}

/** The instant a millisecond offset lands on, as the frozen clock reports it. */
function occurredAt(offsetMs: number): string {
  return `2026-01-01T10:05:00.${String(offsetMs).padStart(3, "0")}Z`;
}

/** One machine, and the story it tells. */
interface CollaborationRuntimeNode {
  readonly nodeId: NodeId;
  readonly participantId: ParticipantId;
  readonly platform: string;
  readonly nodeVersion: string;
  readonly capability: string;
  readonly clientVersion: EventEnvelopeVersion;
  readonly registeredAtMs: number;
  readonly onlineAtMs: number;
  /**
   * The identifiers the three beats every machine plays travel under.
   *
   * On the machine rather than composed at the beat site, for the table's own reason:
   * an event id names one row of one session's log, and a beat builder that minted
   * them from an index would answer with a different id the day a beat is inserted
   * ahead of it.
   */
  readonly registrationEventId: string;
  readonly declarationEventId: string;
  readonly arrivalEventId: string;
  /**
   * When and under which id the machine left. Absent means it came up and stayed.
   *
   * One member rather than two optionals, so a machine cannot carry an instant with
   * no id or an id with no instant — and so the beat builder narrows both at once.
   */
  readonly departure?: { readonly atMs: number; readonly eventId: string };
}

/**
 * The three machines, one per participant who brought one.
 *
 * ONE TABLE, on the rule `collaboration.ts`'s participant and channel tables state:
 * a node's registration beat, its capability declaration, its lifecycle transitions,
 * and its roster rows are all views of one machine, and hand-written copies of one
 * machine drift where nothing catches it.
 *
 * The runner reports a version below this session's floor, so the roster derives
 * `readOnly` for it and the machine stays in the set as an admitted read-only peer.
 * A roster that dropped it would be hiding a participant's own machine from her.
 */
function machinesOf(script: CollaborationRuntimeNodeScript): readonly CollaborationRuntimeNode[] {
  const [laptopOwnerId, desktopOwnerId, runnerOwnerId] = script.ownerParticipantIds;
  return [
    {
      nodeId: NODE_LAPTOP,
      registrationEventId: "019b7904-8ce0-7ea1-8310-cca0117a0421",
      declarationEventId: "019b7904-8ce0-7ea1-8320-cca0117a0424",
      arrivalEventId: "019b7904-8ce0-7ea1-8330-cca0117a0427",
      participantId: laptopOwnerId,
      // Composite `platform+arch` values are exactly what this bounded free string
      // is for; it is deliberately not an enum, because no source enumerates the set.
      platform: "darwin-arm64",
      nodeVersion: "1.4.2",
      capability: "provider-driver",
      clientVersion: CLIENT_VERSION_CURRENT,
      registeredAtMs: 440,
      onlineAtMs: 540,
    },
    {
      nodeId: NODE_DESKTOP,
      registrationEventId: "019b7904-8ce0-7ea1-8340-cca0117a0422",
      declarationEventId: "019b7904-8ce0-7ea1-8350-cca0117a0425",
      arrivalEventId: "019b7904-8ce0-7ea1-8360-cca0117a0428",
      participantId: desktopOwnerId,
      platform: "linux-x64",
      nodeVersion: "1.4.1",
      capability: "provider-driver",
      clientVersion: CLIENT_VERSION_CURRENT,
      registeredAtMs: 460,
      onlineAtMs: 560,
    },
    {
      nodeId: NODE_RUNNER,
      registrationEventId: "019b7904-8ce0-7ea1-8370-cca0117a0423",
      declarationEventId: "019b7904-8ce0-7ea1-8380-cca0117a0426",
      arrivalEventId: "019b7904-8ce0-7ea1-8390-cca0117a0429",
      participantId: runnerOwnerId,
      platform: "linux-arm64",
      nodeVersion: "1.2.7",
      capability: "provider-driver",
      clientVersion: CLIENT_VERSION_BELOW_FLOOR,
      registeredAtMs: 480,
      onlineAtMs: 580,
      departure: { atMs: 640, eventId: "019b7904-8ce0-7ea1-83a0-cca0117a0430" },
    },
  ];
}

/** The instant the runner's last heartbeat landed, shared by the beat and the read. */
const RUNNER_LAST_HEARTBEAT_MS = 635;

/** One beat before it is given its position in the log. */
interface UnnumberedBeat {
  readonly atMs: number;
  readonly event: Omit<ScenarioBeat["event"], "sequence">;
}

/**
 * Put the beats in the order they fall due and number them from there.
 *
 * The four groups below are written one KIND at a time, which is how they are
 * legible — every registration together, then every declaration — and that is not
 * the order they happen in: the second machine registers at 460ms after the first
 * has already declared at 460ms too. The engine consumes beats in array order as the
 * frozen clock reaches them, so a group-ordered array delivers a beat later than it
 * is scripted for, and a log position assigned per group then disagrees with the
 * order it is delivered in. Both are defects `scenarios/wire-truth.ts` reports.
 *
 * So the due order is computed rather than hand-maintained, and the sequence is
 * assigned from it. The sort is stable, so two beats at one tick keep the order the
 * groups put them in — which is the causal one: a machine registers before another
 * declares at the same instant.
 */
function numberedInDueOrder(
  beats: readonly UnnumberedBeat[],
  firstSequence: number,
): readonly ScenarioBeat[] {
  return [...beats]
    .sort((left, right) => left.atMs - right.atMs)
    .map((beat, beatIndex) => ({
      atMs: beat.atMs,
      event: { ...beat.event, sequence: firstSequence + beatIndex },
    }));
}

/**
 * Every `runtime_node.*` beat these machines play, in log order.
 *
 * Each `kind` is a registered wire event type carrying the registered payload, and
 * `scenarios/wire-truth.ts` holds all of them to both. Three payload shapes appear
 * and the differences between them are the contract's, not this file's: registration
 * carries the full lifecycle base plus what it declares, the capability event carries
 * the REDUCED base with no state transition at all, and the departure carries the
 * base plus the two members a departure adds.
 */
export function collaborationRuntimeNodeBeats(
  script: CollaborationRuntimeNodeScript,
): readonly ScenarioBeat[] {
  const machines = machinesOf(script);
  const { sessionId, firstSequence } = script;
  const registrations: readonly UnnumberedBeat[] = machines.map((machine) => ({
    atMs: machine.registeredAtMs,
    event: {
      id: machine.registrationEventId,
      sessionId,
      kind: "runtime_node.registered",
      occurredAt: occurredAt(machine.registeredAtMs),
      // The machine's owner acted; the daemon did not decide to admit somebody
      // else's hardware into the room on its own.
      actorId: machine.participantId,
      // `newState` is `registering` and there is no `previousState`, because a
      // machine being admitted has no state it came from.
      payload: {
        sessionId,
        nodeId: machine.nodeId,
        newState: "registering",
        capabilities: { [machine.capability]: { available: true } },
        nodeVersion: machine.nodeVersion,
        platform: machine.platform,
      },
    },
  }));
  const declarations: readonly UnnumberedBeat[] = machines.map((machine) => ({
    atMs: machine.registeredAtMs + 20,
    event: {
      id: machine.declarationEventId,
      sessionId,
      kind: "runtime_node.capability_declared",
      occurredAt: occurredAt(machine.registeredAtMs + 20),
      actorId: machine.participantId,
      payload: {
        sessionId,
        nodeId: machine.nodeId,
        capability: machine.capability,
        capabilityDetails: { available: true },
      },
    },
  }));
  const arrivals: readonly UnnumberedBeat[] = machines.map((machine) => ({
    atMs: machine.onlineAtMs,
    event: {
      id: machine.arrivalEventId,
      sessionId,
      kind: "runtime_node.online",
      occurredAt: occurredAt(machine.onlineAtMs),
      // No actor. The daemon moves a node online once its capability declaration has
      // been accepted, and naming a participant would attribute a system transition
      // to a person.
      payload: {
        sessionId,
        nodeId: machine.nodeId,
        previousState: "registering",
        newState: "online",
      },
    },
  }));
  const departures: readonly UnnumberedBeat[] = machines
    // Narrowed before it is indexed rather than filtered and then read back through a
    // fallback: `?? 0` would have scripted a departure at tick zero for a machine that
    // never left, and the id has no honest fallback at all.
    .flatMap((machine) =>
      machine.departure === undefined ? [] : [{ machine, departure: machine.departure }],
    )
    .map(({ machine, departure }) => ({
      atMs: departure.atMs,
      event: {
        id: departure.eventId,
        sessionId,
        kind: "runtime_node.offline",
        occurredAt: occurredAt(departure.atMs),
        // A person shut this machine down, so a person is the actor — unlike the two
        // departure reasons the registered enum also carries, which a sweep derives
        // and which no V1 producer authors.
        actorId: machine.participantId,
        // `lastHeartbeatAt` is the same instant the roster frame at this tick
        // reports, because they describe one heartbeat: the beat says the attachment
        // ended, and the read says the sweep still finds the machine healthy.
        payload: {
          sessionId,
          nodeId: machine.nodeId,
          previousState: "online",
          newState: "offline",
          lastHeartbeatAt: occurredAt(RUNNER_LAST_HEARTBEAT_MS),
          reason: "explicit_shutdown",
        },
      },
    }));
  return numberedInDueOrder(
    [...registrations, ...declarations, ...arrivals, ...departures],
    firstSequence,
  );
}

/** One roster row, with the members every machine here shares already filled in. */
function rosterRow(
  machine: CollaborationRuntimeNode,
  reading: {
    readonly state: RuntimeNodeRosterEntry["state"];
    readonly healthState: RuntimeNodeRosterEntry["healthState"];
    readonly lastHeartbeatAtMs: number;
  },
): RuntimeNodeRosterEntry {
  return {
    nodeId: machine.nodeId,
    participantId: machine.participantId,
    state: reading.state,
    healthState: reading.healthState,
    lastHeartbeatAt: occurredAt(reading.lastHeartbeatAtMs),
    // DERIVED at read time from `clientVersion` against the session floor, and the
    // roster is the only place that verdict is legible: no event carries it. A
    // below-floor node is admitted read-only and stays in the set.
    readOnly: machine.clientVersion === CLIENT_VERSION_BELOW_FLOOR,
    capabilities: { [machine.capability]: { available: true } },
    clientVersion: machine.clientVersion,
    attachedAt: occurredAt(machine.registeredAtMs),
  };
}

/**
 * The roster as the registered read answers it, at the three ticks it changes.
 *
 * Frame 0 is EMPTY, and that is a reading rather than an absence: the session exists
 * and no machine has attached to it yet, which the registered response admits
 * explicitly. A script opening with its populated frame would leave the read
 * refusing until 580ms and make the empty roster unreachable from any tick at all.
 *
 * Frame 640 is the one this script exists for. The runner's SLOT axis reaches the
 * departure verdict the `runtime_node.offline` beat announces at that tick, while
 * its LIVENESS axis RECOVERS from `degraded` to `online` — its last heartbeat landed
 * moments before it shut down, and the sweep that owns that axis does not know the
 * attachment is gone. `state: "offline"` beside `healthState: "online"` is the wire
 * contract's own named example of a valid row: the two axes have different owners,
 * nothing on the wire reconciles them, and a client that collapsed them into one
 * scalar would have to pick which of two true readings to report.
 */
export function collaborationRuntimeNodeRoster(
  script: CollaborationRuntimeNodeScript,
): readonly ScenarioRuntimeNodeRosterFrame[] {
  const [laptop, desktop, runner] = machinesOf(script);
  if (laptop === undefined || desktop === undefined || runner === undefined) {
    // Unreachable against the table above, which is a literal of three. Stated
    // rather than asserted away, because a silent `undefined` here would reach the
    // roster as a row whose every member reads blank.
    return [];
  }
  return [
    { atMs: 0, nodes: [] },
    {
      atMs: 580,
      nodes: [
        rosterRow(laptop, { state: "online", healthState: "online", lastHeartbeatAtMs: 570 }),
        rosterRow(desktop, { state: "online", healthState: "online", lastHeartbeatAtMs: 575 }),
        rosterRow(runner, {
          state: "online",
          // Late already on the axis the sweep owns while its slot is still online,
          // so the two axes disagree here AND at 640, in opposite directions.
          healthState: "degraded",
          lastHeartbeatAtMs: 500,
        }),
      ],
    },
    {
      atMs: 640,
      nodes: [
        rosterRow(laptop, { state: "online", healthState: "online", lastHeartbeatAtMs: 630 }),
        rosterRow(desktop, { state: "online", healthState: "online", lastHeartbeatAtMs: 635 }),
        rosterRow(runner, {
          state: "offline",
          healthState: "online",
          lastHeartbeatAtMs: RUNNER_LAST_HEARTBEAT_MS,
        }),
      ],
    },
  ];
}
