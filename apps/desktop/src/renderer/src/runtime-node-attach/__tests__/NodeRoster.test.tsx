// Plan-003 Phase 5 T5.1 — NodeRoster renderer component suite.
//
// BL-131 exit criterion (b), this view's share: bridge-only data access (no
// `node:*` / `electron` / daemon / control-plane imports), the three render
// states (loading / loaded / error), and below-floor read-only surfacing of the
// typed `VERSION_FLOOR_EXCEEDED` refusal. Criterion (c) — the two-client attach
// E2E that replaces the T5.4 manual smoke — is out of scope here and stays open
// on Plan-023 Tier 8.
//
// Spec coverage:
//   • `Spec-003 §Acceptance Criteria` AC4 (below-floor nodes are admitted
//     READ-ONLY and never ejected): the roster renders a below-floor row with
//     its read-only access label — the node is annotated, not filtered out.
//   • `Spec-003 §Required Behavior` (the roster is a FAITHFUL projection): every
//     row the wire returns renders, both health axes verbatim
//     (`state` = the authority/slot axis, `healthState` = the liveness axis),
//     with no client-side hiding, sorting, or re-derivation.
//   • I-003-1 (admit-not-eject): the below-floor row and the
//     `version.floor_exceeded` read-refusal case both keep the surface legible
//     rather than blanking it.
//   • Spec-023 §Trust Stance + `Plan-003 §Cross-Plan Obligations` CP-003-3: the
//     view reaches the control plane and the daemon through no path of its own —
//     `window.sidekicks` by default (the mock bridge below IS that seam), or the
//     optional `reads` seam a host supplies, which is a bridge the host already
//     resolved rather than a second way out of the renderer — and the
//     bridge-projection source scan at the bottom of this file.
//
// Harness: the Vitest `renderer` project (happy-dom) + `@testing-library/react`
// — see `ADR-022 §Decision Log` (2026-08-25) for why renderer component tests
// run there rather than under Browser Mode.
//
// The mock bridge is DUPLICATED per test file (the standing renderer-suite
// directive) rather than hoisted to a shared helper — each view's bridge
// surface differs, and a shared helper would have to widen to their union. What
// is NOT hand-rolled is the arm SHAPE: each arm is typed
// `Pick<SidekicksBridge[...], "...">`, so renaming or removing a bridge member
// upstream fails THIS file's typecheck instead of silently leaving the mock
// describing a bridge that no longer exists.
//
// The two arms differ in what they can enforce, and the difference is measured
// (PR #355 Codex round 1), not assumed:
//   • `daemon.subscribe` returns a CONCRETE `Unsubscribe`, so the typed arm
//     genuinely carries return-type drift — a changed return fails here.
//   • `controlPlane.call` returns `Promise<CpOutput<P>>`, and `CpOutput<P>` is
//     the deferred conditional `P extends CpProcedure ? unknown : never`, i.e.
//     `unknown`. NO typing of that arm can constrain what the call resolves to:
//     `vi.fn<Arm["call"]>()` is not even assignable to the generic signature
//     (TS2322), and a typed mock resolving `{ bogus: true }` compiles clean.
//     Roster-response drift is caught by the annotated RESPONSE FIXTURES below
//     plus the `expectTypeOf` tripwire beside them, which makes that protection
//     structural rather than incidental. Verified by mutation: a new required
//     member on the response interface fails this file at the fixture lines.

import { act, render, screen } from "@testing-library/react";
import type { Mock } from "vitest";

import { NotImplementedAtTier1Error, VERSION_FLOOR_EXCEEDED_CODE } from "@ai-sidekicks/contracts";
import type {
  EventEnvelopeVersion,
  NodeId,
  ParticipantId,
  RuntimeNodeRosterEntry,
  RuntimeNodeRosterRequest,
  RuntimeNodeRosterResponse,
  SessionId,
  SidekicksBridge,
  Unsubscribe,
  VersionFloorExceededError,
} from "@ai-sidekicks/contracts";

import { NodeRoster, type NodeRosterReads } from "../NodeRoster.js";

// CP-003-3 source-text read — Vite `import.meta.glob` raw form. See the
// MixedVersionStatus suite's header for the full rationale (`node:fs` is doubly
// banned in renderer programs, so the source text arrives inlined at transform
// time instead). The augmentation is scoped to this test program.
declare global {
  interface ImportMeta {
    glob: (
      pattern: string,
      options: { query: "?raw"; import: "default"; eager: true },
    ) => Record<string, string>;
  }
}

const runtimeNodeViewSources = import.meta.glob("../*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
});

// --------------------------------------------------------------------------
// Typed bridge arms.
// --------------------------------------------------------------------------
//
// `Pick<...>` over the SHIPPED bridge interface rather than a hand-written
// `{ call: ... }` literal: a renamed or deleted member makes the `Pick`
// constraint itself fail (TS2344) at this line, which is exactly the drift the
// old `as unknown as SidekicksBridge` double assertion could not catch. The
// remaining hole — a bridge method that GAINS a required parameter — is not
// reachable by annotation and stays the Tier-8 IPC dispatcher's job.
type ControlPlaneCallArm = Pick<SidekicksBridge["controlPlane"], "call">;
type DaemonSubscribeArm = Pick<SidekicksBridge["daemon"], "subscribe">;

// NodeRoster reads `window.sidekicks.controlPlane.call` (the `runtimenode.roster`
// read) AND `window.sidekicks.daemon.subscribe` (the `runtime_node.online`
// change signal) — both are required on the mock. Mocking the other four
// capability groups would be unnecessary scaffolding, so the partial object is
// widened once, here, at the install boundary.
function installMockBridge(
  controlPlaneCall: ControlPlaneCallArm["call"],
  daemonSubscribe: DaemonSubscribeArm["subscribe"],
): void {
  const bridge: { controlPlane: ControlPlaneCallArm; daemon: DaemonSubscribeArm } = {
    controlPlane: { call: controlPlaneCall },
    daemon: { subscribe: daemonSubscribe },
  };
  (window as unknown as { sidekicks: SidekicksBridge }).sidekicks =
    bridge as unknown as SidekicksBridge;
}

// A manually-resolvable promise — lets a test hold two roster reads in flight
// and settle them in a CHOSEN order (newer first) to exercise the out-of-order
// guard. `resolve` is assigned synchronously inside the executor, so it is
// always defined by the time a test calls it.
function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const noopUnsubscribe: Unsubscribe = () => {};

const FIRST_SESSION_ID = "01970000-0000-7000-8000-0000000000a1" as SessionId;
const SECOND_SESSION_ID = "01970000-0000-7000-8000-0000000000a2" as SessionId;
const OWNING_PARTICIPANT_ID = "01970000-0000-7000-8000-0000000000b1" as ParticipantId;
const AT_FLOOR_NODE_ID = "01970000-0000-7000-8000-0000000000c1" as NodeId;
const BELOW_FLOOR_NODE_ID = "01970000-0000-7000-8000-0000000000c2" as NodeId;
const REGISTERING_NODE_ID = "01970000-0000-7000-8000-0000000000c3" as NodeId;
const JOINED_LATER_NODE_ID = "01970000-0000-7000-8000-0000000000c4" as NodeId;
const SECOND_SESSION_NODE_ID = "01970000-0000-7000-8000-0000000000c5" as NodeId;

function buildRosterEntry(
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

// The first snapshot deliberately spans all three axes the roster projects:
// an at-floor read-write node, a BELOW-FLOOR read-only node (AC4 — admitted,
// not ejected), and a `registering` node with NO heartbeat yet (`healthState`
// and `lastHeartbeatAt` both null).
const FIRST_SNAPSHOT: RuntimeNodeRosterResponse = {
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

// What a subscribe-triggered re-read returns: a node joined, and the original
// node went offline (it stays on the roster — offline is a rendered state, not
// a removal).
const SECOND_SNAPSHOT: RuntimeNodeRosterResponse = {
  nodes: [
    buildRosterEntry({ nodeId: AT_FLOOR_NODE_ID, state: "offline", healthState: "offline" }),
    buildRosterEntry({ nodeId: JOINED_LATER_NODE_ID }),
  ],
};

const SECOND_SESSION_SNAPSHOT: RuntimeNodeRosterResponse = {
  nodes: [buildRosterEntry({ nodeId: SECOND_SESSION_NODE_ID })],
};

// The drift tripwire, asserted rather than merely annotated — see the header.
// `toEqualTypeOf` is invariant, so widening `RuntimeNodeRosterResponse` or
// loosening a fixture annotation fails HERE, naming this contract.
expectTypeOf(FIRST_SNAPSHOT).toEqualTypeOf<RuntimeNodeRosterResponse>();
expectTypeOf(SECOND_SNAPSHOT).toEqualTypeOf<RuntimeNodeRosterResponse>();
expectTypeOf(SECOND_SESSION_SNAPSHOT).toEqualTypeOf<RuntimeNodeRosterResponse>();
expectTypeOf(
  buildRosterEntry({ nodeId: AT_FLOOR_NODE_ID }),
).toEqualTypeOf<RuntimeNodeRosterEntry>();

const FLOOR_REFUSAL_MESSAGE = "client version 1.0 is below the session floor 2.0";
const FLOOR_REFUSAL_ENVELOPE: VersionFloorExceededError = {
  code: VERSION_FLOOR_EXCEEDED_CODE,
  message: FLOOR_REFUSAL_MESSAGE,
  details: {
    attemptedVersion: "1.0",
    acceptedRange: { min: "2.0", max: "2.0" },
  },
};

// Captures the `runtime_node.online` handler the view registers so a test can
// drive a health push. The concrete implementation (rather than a bare
// `vi.fn()`) is deliberate: it is what makes the arm's RETURN type — the
// `Unsubscribe` contract — actually checked against the shipped bridge shape.
type DaemonSubscribeMock = Mock<
  (event: string, handler: (payload: unknown) => void) => Unsubscribe
>;

function createSubscribeCapture(unsubscribe: Unsubscribe = noopUnsubscribe): {
  daemonSubscribe: DaemonSubscribeMock;
  emitNodeHealthPush: () => void;
} {
  let registeredHandler: ((payload: unknown) => void) | undefined;
  const daemonSubscribe = vi.fn(
    (_event: string, handler: (payload: unknown) => void): Unsubscribe => {
      registeredHandler = handler;
      return unsubscribe;
    },
  );
  const emitNodeHealthPush = (): void => {
    if (registeredHandler === undefined) {
      throw new Error("NodeRoster registered no runtime_node.online handler");
    }
    registeredHandler({});
  };
  return { daemonSubscribe, emitNodeHealthPush };
}

// Component under test: `NodeRoster` (Plan-003 Phase 5 T5.1).
describe("NodeRoster", () => {
  afterEach(() => {
    delete (window as unknown as { sidekicks?: SidekicksBridge }).sidekicks;
    vi.clearAllMocks();
  });

  describe("loading state", () => {
    it("renders the busy loading section before the mount read resolves", () => {
      // Mount-triggered view: it STARTS in `loading`. An un-settling read keeps
      // it there so the synchronous query observes the in-flight branch.
      const controlPlaneCall = vi.fn().mockReturnValue(new Promise(() => {}));
      const { daemonSubscribe } = createSubscribeCapture();
      installMockBridge(controlPlaneCall, daemonSubscribe);

      render(<NodeRoster sessionId={FIRST_SESSION_ID} />);

      const loadingSection = screen.getByLabelText("node-roster-loading");
      expect(loadingSection.getAttribute("aria-busy")).toBe("true");
      expect(controlPlaneCall).toHaveBeenCalledWith("runtimenode.roster", {
        sessionId: FIRST_SESSION_ID,
      });
    });

    it("subscribes to runtime_node.online BEFORE issuing the first read", () => {
      // Subscribe-before-read: a health push that lands while the first read is
      // in flight must not be missed. Reversing the order in the view would
      // open exactly that window, and this ordering proof is what closes it.
      const controlPlaneCall = vi.fn().mockReturnValue(new Promise(() => {}));
      const { daemonSubscribe } = createSubscribeCapture();
      installMockBridge(controlPlaneCall, daemonSubscribe);

      render(<NodeRoster sessionId={FIRST_SESSION_ID} />);

      expect(daemonSubscribe).toHaveBeenCalledWith("runtime_node.online", expect.any(Function));
      const [subscribeInvocationOrder] = daemonSubscribe.mock.invocationCallOrder;
      const [readInvocationOrder] = controlPlaneCall.mock.invocationCallOrder;
      expect(subscribeInvocationOrder).toBeLessThan(readInvocationOrder as number);
    });
  });

  describe("loaded projection", () => {
    it("renders every wire row with both health axes verbatim", async () => {
      const controlPlaneCall = vi.fn().mockResolvedValue(FIRST_SNAPSHOT);
      const { daemonSubscribe } = createSubscribeCapture();
      installMockBridge(controlPlaneCall, daemonSubscribe);

      render(<NodeRoster sessionId={FIRST_SESSION_ID} />);

      const loadedSection = await screen.findByLabelText("node-roster-loaded");
      const renderedRows = loadedSection.querySelectorAll("li");
      expect(renderedRows).toHaveLength(FIRST_SNAPSHOT.nodes.length);
      for (const rosterEntry of FIRST_SNAPSHOT.nodes) {
        expect(screen.getByText(`node id: ${rosterEntry.nodeId}`)).toBeDefined();
      }
      // Slot axis (`state`) and liveness axis (`healthState`) render
      // SEPARATELY — the degraded below-floor node carries both.
      const belowFloorRow = loadedSection.querySelector(
        `li[data-node-state="degraded"][data-health-state="degraded"]`,
      );
      expect(belowFloorRow).not.toBeNull();
    });

    // `Spec-003 §Acceptance Criteria` AC4.
    it("renders a below-floor node read-only rather than dropping it", async () => {
      const controlPlaneCall = vi.fn().mockResolvedValue(FIRST_SNAPSHOT);
      const { daemonSubscribe } = createSubscribeCapture();
      installMockBridge(controlPlaneCall, daemonSubscribe);

      render(<NodeRoster sessionId={FIRST_SESSION_ID} />);

      const loadedSection = await screen.findByLabelText("node-roster-loaded");
      const readOnlyRows = loadedSection.querySelectorAll('li[data-read-only="true"]');
      expect(readOnlyRows).toHaveLength(1);
      expect(screen.getByText("access: read-only (below version floor)")).toBeDefined();
      // …and the at-floor nodes are unaffected.
      expect(loadedSection.querySelectorAll('li[data-read-only="false"]')).toHaveLength(2);
    });

    it("renders a node with no heartbeat yet without inventing a liveness value", async () => {
      const controlPlaneCall = vi.fn().mockResolvedValue(FIRST_SNAPSHOT);
      const { daemonSubscribe } = createSubscribeCapture();
      installMockBridge(controlPlaneCall, daemonSubscribe);

      render(<NodeRoster sessionId={FIRST_SESSION_ID} />);

      const loadedSection = await screen.findByLabelText("node-roster-loaded");
      const registeringRow = loadedSection.querySelector('li[data-node-state="registering"]');
      expect(registeringRow).not.toBeNull();
      // A null liveness axis is ABSENT from the machine-readable facet rather
      // than coerced to a state the node never reported.
      expect(registeringRow?.getAttribute("data-health-state")).toBeNull();
      expect(screen.getByText("liveness: none (no heartbeat yet)")).toBeDefined();
      expect(screen.getByText("last heartbeat: none (no heartbeat yet)")).toBeDefined();
    });

    it("renders the loaded (not error, not loading) state for an empty roster", async () => {
      // A session with no attachments is a legitimate empty projection.
      const controlPlaneCall = vi.fn().mockResolvedValue({ nodes: [] });
      const { daemonSubscribe } = createSubscribeCapture();
      installMockBridge(controlPlaneCall, daemonSubscribe);

      render(<NodeRoster sessionId={FIRST_SESSION_ID} />);

      const loadedSection = await screen.findByLabelText("node-roster-loaded");
      expect(loadedSection.querySelectorAll("li")).toHaveLength(0);
      expect(screen.queryByLabelText("node-roster-error")).toBeNull();
      expect(screen.queryByLabelText("node-roster-loading")).toBeNull();
    });
  });

  describe("error state", () => {
    it("surfaces a typed version-floor read refusal with its wire code as the error name", async () => {
      const controlPlaneCall = vi.fn().mockRejectedValue(FLOOR_REFUSAL_ENVELOPE);
      const { daemonSubscribe } = createSubscribeCapture();
      installMockBridge(controlPlaneCall, daemonSubscribe);

      render(<NodeRoster sessionId={FIRST_SESSION_ID} />);

      const errorSection = await screen.findByRole("alert", { name: "node-roster-error" });
      expect(errorSection.textContent).toContain(VERSION_FLOOR_EXCEEDED_CODE);
      expect(errorSection.textContent).toContain(FLOOR_REFUSAL_MESSAGE);
    });

    it("surfaces a thrown Error's name and message", async () => {
      const controlPlaneCall = vi
        .fn()
        .mockRejectedValue(new TypeError("control plane unreachable"));
      const { daemonSubscribe } = createSubscribeCapture();
      installMockBridge(controlPlaneCall, daemonSubscribe);

      render(<NodeRoster sessionId={FIRST_SESSION_ID} />);

      const errorSection = await screen.findByRole("alert", { name: "node-roster-error" });
      expect(errorSection.textContent).toContain("TypeError");
      expect(errorSection.textContent).toContain("control plane unreachable");
    });

    it("renders the error state when the bridge subscribe throws synchronously", async () => {
      // The Tier-1 bridge stub throws `NotImplementedAtTier1Error` SYNCHRONOUSLY
      // from every method. The view must degrade to its error state rather than
      // letting the throw escape the effect — and, since subscribe runs first,
      // the roster read is never issued.
      const controlPlaneCall = vi.fn().mockResolvedValue(FIRST_SNAPSHOT);
      const daemonSubscribe = vi.fn((): Unsubscribe => {
        throw new NotImplementedAtTier1Error("daemon.subscribe");
      });
      installMockBridge(controlPlaneCall, daemonSubscribe);

      render(<NodeRoster sessionId={FIRST_SESSION_ID} />);

      const errorSection = await screen.findByRole("alert", { name: "node-roster-error" });
      expect(errorSection.textContent).toContain("NotImplementedAtTier1Error");
      expect(controlPlaneCall).not.toHaveBeenCalled();
    });
  });

  describe("health-push refresh", () => {
    it("re-reads the roster when a runtime_node.online push arrives", async () => {
      const controlPlaneCall = vi
        .fn()
        .mockResolvedValueOnce(FIRST_SNAPSHOT)
        .mockResolvedValueOnce(SECOND_SNAPSHOT);
      const { daemonSubscribe, emitNodeHealthPush } = createSubscribeCapture();
      installMockBridge(controlPlaneCall, daemonSubscribe);

      render(<NodeRoster sessionId={FIRST_SESSION_ID} />);
      await screen.findByText(`node id: ${AT_FLOOR_NODE_ID}`);

      act(() => {
        emitNodeHealthPush();
      });

      await screen.findByText(`node id: ${JOINED_LATER_NODE_ID}`);
      expect(controlPlaneCall).toHaveBeenCalledTimes(2);
      // The node that went offline is still ON the roster — offline is a
      // rendered state, not a removal.
      const offlineRow = screen
        .getByLabelText("node-roster-loaded")
        .querySelector('li[data-node-state="offline"]');
      expect(offlineRow).not.toBeNull();
      expect(screen.queryByText(`node id: ${REGISTERING_NODE_ID}`)).toBeNull();
    });

    it("does not flicker back to loading while the re-read is in flight", async () => {
      // The no-flicker contract: a refresh keeps the last good snapshot on
      // screen until the new one lands. Resetting to `loading` on every push
      // would blank a live roster on every heartbeat.
      const heldSecondRead = createDeferred<RuntimeNodeRosterResponse>();
      const controlPlaneCall = vi
        .fn()
        .mockResolvedValueOnce(FIRST_SNAPSHOT)
        .mockReturnValueOnce(heldSecondRead.promise);
      const { daemonSubscribe, emitNodeHealthPush } = createSubscribeCapture();
      installMockBridge(controlPlaneCall, daemonSubscribe);

      render(<NodeRoster sessionId={FIRST_SESSION_ID} />);
      await screen.findByText(`node id: ${AT_FLOOR_NODE_ID}`);

      act(() => {
        emitNodeHealthPush();
      });

      expect(screen.queryByLabelText("node-roster-loading")).toBeNull();
      expect(screen.getByText(`node id: ${AT_FLOOR_NODE_ID}`)).toBeDefined();

      await act(async () => {
        heldSecondRead.resolve(SECOND_SNAPSHOT);
        await heldSecondRead.promise;
      });
      expect(screen.getByText(`node id: ${JOINED_LATER_NODE_ID}`)).toBeDefined();
    });

    it("drops a stale in-flight read that settles after a newer one", async () => {
      // Out-of-order guard: read #1 (mount) and read #2 (health push) are both
      // in flight; #2 settles FIRST, then #1. The older response must not
      // overwrite the newer roster.
      const firstRead = createDeferred<RuntimeNodeRosterResponse>();
      const secondRead = createDeferred<RuntimeNodeRosterResponse>();
      const controlPlaneCall = vi
        .fn()
        .mockReturnValueOnce(firstRead.promise)
        .mockReturnValueOnce(secondRead.promise);
      const { daemonSubscribe, emitNodeHealthPush } = createSubscribeCapture();
      installMockBridge(controlPlaneCall, daemonSubscribe);

      render(<NodeRoster sessionId={FIRST_SESSION_ID} />);
      act(() => {
        emitNodeHealthPush();
      });
      expect(controlPlaneCall).toHaveBeenCalledTimes(2);

      await act(async () => {
        secondRead.resolve(SECOND_SNAPSHOT);
        await secondRead.promise;
      });
      expect(screen.getByText(`node id: ${JOINED_LATER_NODE_ID}`)).toBeDefined();

      await act(async () => {
        firstRead.resolve(FIRST_SNAPSHOT);
        await firstRead.promise;
      });
      // Still the NEWER snapshot: the stale response was discarded.
      expect(screen.getByText(`node id: ${JOINED_LATER_NODE_ID}`)).toBeDefined();
      expect(screen.queryByText(`node id: ${REGISTERING_NODE_ID}`)).toBeNull();
    });
  });

  describe("lifecycle", () => {
    it("resets to loading and re-reads when the session prop changes", async () => {
      const controlPlaneCall = vi
        .fn()
        .mockResolvedValueOnce(FIRST_SNAPSHOT)
        .mockResolvedValueOnce(SECOND_SESSION_SNAPSHOT);
      const { daemonSubscribe } = createSubscribeCapture();
      installMockBridge(controlPlaneCall, daemonSubscribe);

      const { rerender } = render(<NodeRoster sessionId={FIRST_SESSION_ID} />);
      await screen.findByText(`node id: ${AT_FLOOR_NODE_ID}`);

      rerender(<NodeRoster sessionId={SECOND_SESSION_ID} />);

      // The prior session's roster must not linger as if it were this one's.
      expect(screen.getByLabelText("node-roster-loading")).toBeDefined();
      expect(screen.queryByText(`node id: ${AT_FLOOR_NODE_ID}`)).toBeNull();

      await screen.findByText(`node id: ${SECOND_SESSION_NODE_ID}`);
      expect(controlPlaneCall).toHaveBeenLastCalledWith("runtimenode.roster", {
        sessionId: SECOND_SESSION_ID,
      });
    });

    it("unsubscribes from the health signal on unmount", async () => {
      const unsubscribeSpy = vi.fn();
      const controlPlaneCall = vi.fn().mockResolvedValue(FIRST_SNAPSHOT);
      const { daemonSubscribe } = createSubscribeCapture(unsubscribeSpy);
      installMockBridge(controlPlaneCall, daemonSubscribe);

      const { unmount } = render(<NodeRoster sessionId={FIRST_SESSION_ID} />);
      await screen.findByLabelText("node-roster-loaded");

      unmount();

      expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
    });

    it("drops the previous session's read when it settles after the session switched", async () => {
      // The per-effect `cancelled` flag, which is a DIFFERENT guard from the
      // per-effect `latestRequestSequence` counter: the sequence counter is
      // re-created by the new session's effect, so it cannot recognize the old
      // session's response as stale. Only the retired effect's own `cancelled`
      // flag stops session A's late roster from being painted into session B's
      // view — a cross-session data leak, not merely a stale render.
      const firstSessionRead = createDeferred<RuntimeNodeRosterResponse>();
      const secondSessionRead = createDeferred<RuntimeNodeRosterResponse>();
      const controlPlaneCall = vi
        .fn()
        .mockReturnValueOnce(firstSessionRead.promise)
        .mockReturnValueOnce(secondSessionRead.promise);
      const { daemonSubscribe } = createSubscribeCapture();
      installMockBridge(controlPlaneCall, daemonSubscribe);

      const { rerender } = render(<NodeRoster sessionId={FIRST_SESSION_ID} />);
      rerender(<NodeRoster sessionId={SECOND_SESSION_ID} />);

      await act(async () => {
        secondSessionRead.resolve(SECOND_SESSION_SNAPSHOT);
        await secondSessionRead.promise;
      });
      expect(screen.getByText(`node id: ${SECOND_SESSION_NODE_ID}`)).toBeDefined();

      await act(async () => {
        firstSessionRead.resolve(FIRST_SNAPSHOT);
        await firstSessionRead.promise;
      });
      // Session A's nodes never reach session B's roster.
      expect(screen.queryByText(`node id: ${AT_FLOOR_NODE_ID}`)).toBeNull();
      expect(screen.getByText(`node id: ${SECOND_SESSION_NODE_ID}`)).toBeDefined();
    });
  });

  describe("the injectable read seam", () => {
    // `NodeRosterProps.reads` is additive and optional. Every case above omits
    // it and therefore drives the DEFAULT arm — the `window.sidekicks` pair this
    // view has always used — so these cases drive the other arm, and each one
    // carries the negative control that proves the two arms are actually
    // different. A seam whose default is "unchanged" has to earn both halves of
    // that claim: the injected pair must be the one that answers, and the
    // installed bridge must be the one that answers when nothing is injected.

    /** A supplied seam, plus the handles a case needs to drive it. */
    interface InjectedSeam {
      readonly reads: NodeRosterReads;
      readonly readRoster: Mock<
        (request: RuntimeNodeRosterRequest) => Promise<RuntimeNodeRosterResponse>
      >;
      readonly subscribePresence: Mock<
        (sessionId: SessionId, onPresenceChange: () => void) => Unsubscribe
      >;
      /** Fire the presence signal the view registered. Throws if it registered none. */
      readonly emitPresenceChange: () => void;
    }

    function createInjectedSeam(options: {
      readonly readRoster: (
        request: RuntimeNodeRosterRequest,
      ) => Promise<RuntimeNodeRosterResponse>;
      readonly unsubscribe?: Unsubscribe;
      /** Set to drive the arm where a host has no live channel to offer. */
      readonly subscribeThrows?: Error;
    }): InjectedSeam {
      let registeredHandler: (() => void) | undefined;
      const readRoster = vi.fn(options.readRoster);
      const subscribePresence = vi.fn(
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
          throw new Error("NodeRoster registered no handler on the injected seam");
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

    it("reads and subscribes through the supplied seam, touching no installed bridge", async () => {
      const controlPlaneCall = vi.fn().mockResolvedValue(SECOND_SESSION_SNAPSHOT);
      const { daemonSubscribe } = createSubscribeCapture();
      installMockBridge(controlPlaneCall, daemonSubscribe);
      const seam = createInjectedSeam({
        readRoster: async () => await Promise.resolve(FIRST_SNAPSHOT),
      });

      render(<NodeRoster sessionId={FIRST_SESSION_ID} reads={seam.reads} />);

      await screen.findByText(`node id: ${AT_FLOOR_NODE_ID}`);
      // The seam takes the registered REQUEST and no procedure name: which
      // procedure answers a roster read is the wire's fact, not the host's.
      expect(seam.readRoster).toHaveBeenCalledWith({ sessionId: FIRST_SESSION_ID });
      expect(seam.subscribePresence).toHaveBeenCalledWith(FIRST_SESSION_ID, expect.any(Function));
      expect(controlPlaneCall).not.toHaveBeenCalled();
      expect(daemonSubscribe).not.toHaveBeenCalled();
      // …and the installed bridge's own snapshot never reached the screen.
      expect(screen.queryByText(`node id: ${SECOND_SESSION_NODE_ID}`)).toBeNull();
    });

    it("negative control: with no seam supplied the installed bridge answers, unchanged", async () => {
      // Without this, the case above would pass over a view that had stopped
      // reading the installed bridge at all — which is exactly the regression an
      // additive, defaulted prop exists to rule out.
      const controlPlaneCall = vi.fn().mockResolvedValue(SECOND_SESSION_SNAPSHOT);
      const { daemonSubscribe } = createSubscribeCapture();
      installMockBridge(controlPlaneCall, daemonSubscribe);

      render(<NodeRoster sessionId={FIRST_SESSION_ID} />);

      await screen.findByText(`node id: ${SECOND_SESSION_NODE_ID}`);
      expect(controlPlaneCall).toHaveBeenCalledWith("runtimenode.roster", {
        sessionId: FIRST_SESSION_ID,
      });
      expect(daemonSubscribe).toHaveBeenCalledWith("runtime_node.online", expect.any(Function));
    });

    it("re-reads on a supplied presence signal without flashing back to loading", async () => {
      // The no-flicker contract, held on the injected arm too: a host driving the
      // signal must not blank a roster that is already on screen.
      const heldReRead = createDeferred<RuntimeNodeRosterResponse>();
      const readRoster = vi
        .fn<(request: RuntimeNodeRosterRequest) => Promise<RuntimeNodeRosterResponse>>()
        .mockResolvedValueOnce(FIRST_SNAPSHOT)
        .mockReturnValueOnce(heldReRead.promise);
      const seam = createInjectedSeam({ readRoster });

      render(<NodeRoster sessionId={FIRST_SESSION_ID} reads={seam.reads} />);
      const firstRow = await screen.findByText(`node id: ${AT_FLOOR_NODE_ID}`);

      act(() => {
        seam.emitPresenceChange();
      });

      expect(screen.queryByLabelText("node-roster-loading")).toBeNull();
      // The SAME node, not merely an equal one: an unmount-and-remount between
      // reads is the flash this contract forbids, and re-querying by text alone
      // could not tell the two apart.
      expect(screen.getByText(`node id: ${AT_FLOOR_NODE_ID}`)).toBe(firstRow);

      await act(async () => {
        heldReRead.resolve(SECOND_SNAPSHOT);
        await heldReRead.promise;
      });
      expect(screen.getByText(`node id: ${JOINED_LATER_NODE_ID}`)).toBeDefined();
      expect(seam.readRoster).toHaveBeenCalledTimes(2);
    });

    it("drops a stale supplied read that settles after a newer one", async () => {
      // The out-of-order guard is effect-scoped and therefore independent of
      // where the reads come from — which is a claim, and this is it checked.
      const firstRead = createDeferred<RuntimeNodeRosterResponse>();
      const secondRead = createDeferred<RuntimeNodeRosterResponse>();
      const readRoster = vi
        .fn<(request: RuntimeNodeRosterRequest) => Promise<RuntimeNodeRosterResponse>>()
        .mockReturnValueOnce(firstRead.promise)
        .mockReturnValueOnce(secondRead.promise);
      const seam = createInjectedSeam({ readRoster });

      render(<NodeRoster sessionId={FIRST_SESSION_ID} reads={seam.reads} />);
      act(() => {
        seam.emitPresenceChange();
      });
      expect(seam.readRoster).toHaveBeenCalledTimes(2);

      await act(async () => {
        secondRead.resolve(SECOND_SNAPSHOT);
        await secondRead.promise;
      });
      await act(async () => {
        firstRead.resolve(FIRST_SNAPSHOT);
        await firstRead.promise;
      });

      expect(screen.getByText(`node id: ${JOINED_LATER_NODE_ID}`)).toBeDefined();
      expect(screen.queryByText(`node id: ${REGISTERING_NODE_ID}`)).toBeNull();
    });

    it("surfaces a supplied read's rejection in the error arm, code first", async () => {
      // A host with no answer rejects rather than resolving an empty roster, and
      // the rejection carries the refuser's own code as the error name — which is
      // what the shipped normalizer already renders for a wire refusal.
      const refusal = new Error("This scenario names no runtime-node roster at this tick.");
      refusal.name = "roster-unscripted";
      const seam = createInjectedSeam({ readRoster: async () => await Promise.reject(refusal) });

      render(<NodeRoster sessionId={FIRST_SESSION_ID} reads={seam.reads} />);

      const errorSection = await screen.findByRole("alert", { name: "node-roster-error" });
      expect(errorSection.textContent).toContain("roster-unscripted");
      expect(errorSection.textContent).toContain("names no runtime-node roster");
    });

    it("renders the error arm and skips the read when the supplied subscribe throws", async () => {
      // A host that cannot open a live channel throws here for the same reason
      // the Tier-1 stub does, and the same arm catches it: a roster that believed
      // it was live and never re-read would go quietly stale, which is the one
      // failure a live roster exists to prevent.
      const seam = createInjectedSeam({
        readRoster: async () => await Promise.resolve(FIRST_SNAPSHOT),
        subscribeThrows: Object.assign(new Error("No presence channel here."), {
          name: "presence-unavailable",
        }),
      });

      render(<NodeRoster sessionId={FIRST_SESSION_ID} reads={seam.reads} />);

      const errorSection = await screen.findByRole("alert", { name: "node-roster-error" });
      expect(errorSection.textContent).toContain("presence-unavailable");
      expect(seam.readRoster).not.toHaveBeenCalled();
    });

    it("follows the seam when a host replaces the transport under one session", async () => {
      // The console's bridge provider REPLACES its resolution as state without
      // remounting its children — a scenario swap, a supplied-bridge change, or a
      // disposed engine re-minted on a second mount. The session id does not move
      // through any of that, so the seam is the only signal there is; a roster
      // that ignored it would stay subscribed to a bridge that has been torn down
      // and keep showing its rows.
      const releaseFirstSeam = vi.fn();
      const firstSeam = createInjectedSeam({
        readRoster: async () => await Promise.resolve(FIRST_SNAPSHOT),
        unsubscribe: releaseFirstSeam,
      });
      const secondSeam = createInjectedSeam({
        readRoster: async () => await Promise.resolve(SECOND_SNAPSHOT),
      });

      const { rerender } = render(
        <NodeRoster sessionId={FIRST_SESSION_ID} reads={firstSeam.reads} />,
      );
      await screen.findByText(`node id: ${REGISTERING_NODE_ID}`);

      rerender(<NodeRoster sessionId={FIRST_SESSION_ID} reads={secondSeam.reads} />);
      await screen.findByText(`node id: ${JOINED_LATER_NODE_ID}`);

      // Released, subscribed, and read — all three through the second transport.
      expect(releaseFirstSeam).toHaveBeenCalledTimes(1);
      expect(secondSeam.subscribePresence).toHaveBeenCalledTimes(1);
      expect(secondSeam.readRoster).toHaveBeenCalledWith({ sessionId: FIRST_SESSION_ID });
      // And the first transport is not asked again, which is the half a dependency
      // added without releasing the old subscription would fail.
      expect(firstSeam.readRoster).toHaveBeenCalledTimes(1);
      // The rows on screen come from the SECOND bridge: the first one's
      // registering node is gone rather than merely joined by the second's rows.
      expect(screen.queryByText(`node id: ${REGISTERING_NODE_ID}`)).toBeNull();
    });

    it("negative control: an unchanged seam re-rendered does not resubscribe", async () => {
      // The other half of the dependency, and the reason the seam is cached per
      // bridge rather than composed per render: this case is what a dependency on
      // a freshly built pair would fail, tearing the subscription down and
      // re-opening it on every render of whatever mounts the roster.
      const releaseSeam = vi.fn();
      const seam = createInjectedSeam({
        readRoster: async () => await Promise.resolve(FIRST_SNAPSHOT),
        unsubscribe: releaseSeam,
      });

      const { rerender } = render(<NodeRoster sessionId={FIRST_SESSION_ID} reads={seam.reads} />);
      await screen.findByText(`node id: ${AT_FLOOR_NODE_ID}`);

      rerender(<NodeRoster sessionId={FIRST_SESSION_ID} reads={seam.reads} />);
      rerender(<NodeRoster sessionId={FIRST_SESSION_ID} reads={seam.reads} />);

      expect(seam.subscribePresence).toHaveBeenCalledTimes(1);
      expect(seam.readRoster).toHaveBeenCalledTimes(1);
      expect(releaseSeam).not.toHaveBeenCalled();
    });

    it("releases the supplied subscription on unmount", async () => {
      const unsubscribeSpy = vi.fn();
      const seam = createInjectedSeam({
        readRoster: async () => await Promise.resolve(FIRST_SNAPSHOT),
        unsubscribe: unsubscribeSpy,
      });

      const { unmount } = render(<NodeRoster sessionId={FIRST_SESSION_ID} reads={seam.reads} />);
      await screen.findByLabelText("node-roster-loaded");

      unmount();

      expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("bridge-projection", () => {
    // Spec-023 §Trust Stance + Plan-003 CP-003-3, and BL-131 exit criterion (b)
    // ("assert bridge-only data access (no `node:*`/`electron` imports)"). The
    // `@ai-sidekicks/runtime-daemon` / `@ai-sidekicks/control-plane` arm has no
    // lint rule today (deferred to the Plan-023 Tier 8 remainder), so for that
    // arm this tripwire is the sole operational enforcement.
    //
    // All three patterns anchor on the IMPORT SURFACE, never on bare words:
    // this source discusses "the local daemon" and spells "no `electron`, no
    // `node:*`" in PROSE, which a naive substring match would false-positive.
    const bannedModuleSource =
      "(?:@ai-sidekicks/(?:runtime-daemon|control-plane)(?:/[^\"'`]*)?" +
      "|[^\"'`]*packages/(?:runtime-daemon|control-plane)/[^\"'`]*" +
      "|node:[^\"'`]+" +
      "|(?:fs|path|os|net|child_process|process)" +
      "|electron(?:/[^\"'`]*)?)";

    const bannedDirectImportPatterns: ReadonlyArray<readonly [string, RegExp, string]> = [
      [
        "bannedFromImport",
        new RegExp(`from\\s*["'\`]${bannedModuleSource}["'\`]`),
        'import { readFile } from "node:fs/promises";',
      ],
      [
        "bannedSideEffectImport",
        new RegExp(`import\\s*["'\`]${bannedModuleSource}["'\`]`),
        'import "@ai-sidekicks/control-plane";',
      ],
      [
        "bannedDynamicImport",
        new RegExp(`import\\s*\\(\\s*["'\`]${bannedModuleSource}["'\`]`),
        'const daemon = await import("@ai-sidekicks/runtime-daemon");',
      ],
    ];

    const nodeRosterSource = runtimeNodeViewSources["../NodeRoster.tsx"];
    if (typeof nodeRosterSource !== "string") {
      throw new Error("NodeRoster.tsx source was not loaded by import.meta.glob");
    }

    // Negative control: a tripwire that has never fired positive proves nothing.
    it.each(bannedDirectImportPatterns)(
      "%s matches a synthetic violating import (negative control)",
      (_bannedImportPatternName, bannedImportPattern, violatingImportSample) => {
        expect(bannedImportPattern.test(violatingImportSample)).toBe(true);
      },
    );

    it.each(bannedDirectImportPatterns)(
      "NodeRoster.tsx source matches no %s",
      (_bannedImportPatternName, bannedImportPattern) => {
        expect(bannedImportPattern.test(nodeRosterSource)).toBe(false);
      },
    );
  });
});
