// The roster suites' one scaffolding home: the seam builder, the response
// fixtures, and the deferred promise both files drive their ordering cases with.
//
// `NodeRoster.render.test.tsx` and `NodeRoster.read.test.tsx` split the component
// along its own seam — what the rows say versus when they change — and both mount
// the same component with the same required `reads` pair. A second copy of the
// builder in one of them is the drift the shared home exists to stop: a fixture
// gaining a required member has to move once.
//
// THE SEAM IS BUILT, NEVER A BRIDGE INSTALLED. `NodeRosterProps.reads` is required,
// so there is no `window.sidekicks` arm to mock, no global to install, and no
// `afterEach` deleting one. That is the point of the required prop rather than an
// accident of the harness, and `NodeRoster.render.test.tsx` carries the control that
// proves the view touches the global through no path at all.

import { vi } from "vitest";
import type { Mock } from "vitest";

import type {
  EventEnvelopeVersion,
  NodeId,
  ParticipantId,
  RuntimeNodeRosterEntry,
  RuntimeNodeRosterRequest,
  RuntimeNodeRosterResponse,
  SessionId,
  Unsubscribe,
} from "@ai-sidekicks/contracts";

import type { NodeRosterReads } from "../node-roster-reads.js";

export const FIRST_SESSION_ID = "01970000-0000-7000-8000-0000000000a1" as SessionId;
export const SECOND_SESSION_ID = "01970000-0000-7000-8000-0000000000a2" as SessionId;
export const OWNING_PARTICIPANT_ID = "01970000-0000-7000-8000-0000000000b1" as ParticipantId;
export const AT_FLOOR_NODE_ID = "01970000-0000-7000-8000-0000000000c1" as NodeId;
export const BELOW_FLOOR_NODE_ID = "01970000-0000-7000-8000-0000000000c2" as NodeId;
export const REGISTERING_NODE_ID = "01970000-0000-7000-8000-0000000000c3" as NodeId;
export const JOINED_LATER_NODE_ID = "01970000-0000-7000-8000-0000000000c4" as NodeId;
export const SECOND_SESSION_NODE_ID = "01970000-0000-7000-8000-0000000000c5" as NodeId;

/** One roster row, with every axis defaulted to the healthy at-floor reading. */
export function buildRosterEntry(
  overrides: Partial<RuntimeNodeRosterEntry> & Pick<RuntimeNodeRosterEntry, "nodeId">,
): RuntimeNodeRosterEntry {
  return {
    participantId: OWNING_PARTICIPANT_ID,
    state: "online",
    healthState: "online",
    lastHeartbeatAt: "2026-06-10T10:00:00.000Z",
    readOnly: false,
    capabilities: { "shell.exec": true },
    clientVersion: "2.0" as EventEnvelopeVersion,
    attachedAt: "2026-06-10T09:59:00.000Z",
    ...overrides,
  };
}

// The first snapshot deliberately spans all three axes the roster projects: an
// at-floor read-write node, a BELOW-FLOOR read-only node (AC4 — admitted, not
// ejected), and a `registering` node with NO heartbeat yet (`healthState` and
// `lastHeartbeatAt` both null).
export const FIRST_SNAPSHOT: RuntimeNodeRosterResponse = {
  nodes: [
    buildRosterEntry({ nodeId: AT_FLOOR_NODE_ID }),
    buildRosterEntry({
      nodeId: BELOW_FLOOR_NODE_ID,
      readOnly: true,
      clientVersion: "1.0" as EventEnvelopeVersion,
      state: "degraded",
      healthState: "degraded",
    }),
    buildRosterEntry({
      nodeId: REGISTERING_NODE_ID,
      state: "registering",
      healthState: null,
      lastHeartbeatAt: null,
    }),
  ],
};

// What a presence-triggered re-read returns: a node joined, and the original node
// went offline — it stays on the roster, because offline is a rendered state rather
// than a removal.
export const SECOND_SNAPSHOT: RuntimeNodeRosterResponse = {
  nodes: [
    buildRosterEntry({ nodeId: AT_FLOOR_NODE_ID, state: "offline", healthState: "offline" }),
    buildRosterEntry({ nodeId: JOINED_LATER_NODE_ID }),
  ],
};

export const SECOND_SESSION_SNAPSHOT: RuntimeNodeRosterResponse = {
  nodes: [buildRosterEntry({ nodeId: SECOND_SESSION_NODE_ID })],
};

/** What one case's roster read answers. Concrete, so its return type is checked. */
export type RosterReadMock = Mock<
  (request: RuntimeNodeRosterRequest) => Promise<RuntimeNodeRosterResponse>
>;

/** What one case's presence subscription answers. */
export type PresenceSubscribeMock = Mock<
  (sessionId: SessionId, onPresenceChange: () => void) => Unsubscribe
>;

/** A built seam, plus the handles a case needs to drive it. */
export interface DrivenSeam {
  readonly reads: NodeRosterReads;
  readonly readRoster: RosterReadMock;
  readonly subscribePresence: PresenceSubscribeMock;
  /** Fire the presence signal the view registered. Throws if it registered none. */
  readonly emitPresenceChange: () => void;
}

const noopUnsubscribe: Unsubscribe = () => {};

/**
 * Build one transport for the view to read through.
 *
 * `readRoster` is a PARAMETER rather than a value, because every ordering case here
 * is about which of several in-flight reads settles when — so a case supplies a
 * `vi.fn()` whose `mockReturnValueOnce` chain it controls.
 */
export function createDrivenSeam(options: {
  readonly readRoster: (request: RuntimeNodeRosterRequest) => Promise<RuntimeNodeRosterResponse>;
  readonly unsubscribe?: Unsubscribe | undefined;
  /** Set to drive the arm where a host has no live channel to offer. */
  readonly subscribeThrows?: Error | undefined;
}): DrivenSeam {
  let registeredHandler: (() => void) | undefined;
  const readRoster: RosterReadMock = vi.fn(options.readRoster);
  const subscribePresence: PresenceSubscribeMock = vi.fn(
    (_sessionId: SessionId, onPresenceChange: () => void): Unsubscribe => {
      if (options.subscribeThrows !== undefined) {
        throw options.subscribeThrows;
      }
      registeredHandler = onPresenceChange;
      return options.unsubscribe ?? noopUnsubscribe;
    },
  );
  const emitPresenceChange = (): void => {
    if (registeredHandler === undefined) {
      throw new Error("NodeRoster registered no presence handler on the supplied seam");
    }
    registeredHandler();
  };
  return {
    reads: { readRoster, subscribePresence },
    readRoster,
    subscribePresence,
    emitPresenceChange,
  };
}

/** A seam that answers one snapshot to every read. The shape most cases want. */
export function seamServing(snapshot: RuntimeNodeRosterResponse): DrivenSeam {
  return createDrivenSeam({ readRoster: async () => await Promise.resolve(snapshot) });
}

/**
 * A manually-resolvable promise.
 *
 * Lets a case hold two roster reads in flight and settle them in a CHOSEN order
 * (newer first) to exercise the out-of-order guard. `resolve` is assigned
 * synchronously inside the executor, so it is always defined by the time a case
 * calls it.
 */
export function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
