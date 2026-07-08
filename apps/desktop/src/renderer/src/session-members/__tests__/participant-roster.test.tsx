// Plan-002 Phase 6 T6.3 — ParticipantRoster renderer unit suite (Tier 2).
//
// Single-client component smoke for the participant-roster / presence surface,
// per `Plan-002 §Phase 6 — Renderer (Tier 2)` Goal + `Plan-002 §Verification`: Phase 6
// component tests + single-client smoke prove the roster + presence indicators
// render/update via the preload bridge (the two-client end-to-end smoke is
// deferred to Tier 8 per CP-002-5). The phrasing here paraphrases both anchors;
// it is not a verbatim quotation of either.
//
// Spec coverage:
//   • `Spec-002 §Acceptance Criteria` AC1 (an invited participant joins an active session):
//     the loaded-roster test asserts the view renders one row per participant
//     the daemon's presence projection reports.
//   • `Spec-002 §Acceptance Criteria` AC2 ("Membership remains durable when presence goes
//     offline and later returns"): the loaded-roster fixture includes a member
//     with `state: "offline"` and the test asserts that member renders a ROW
//     (with an offline indicator), rather than vanishing — the renderer-contract
//     surface of the durability guarantee.
//   • `Spec-002 §Interfaces And Contracts` (`PresenceUpdate` push +
//     `PresenceRead`): the subscribe-wiring test asserts the view
//     composes `presence.read` (decoded snapshot) with `presence.subscribe`
//     (opaque change-signal that triggers a re-read) — the Option-C design in
//     participant-roster.tsx's header.
//   • Spec-023 §Trust Stance (bridge-projection / CP-002-5): the
//     `describe("bridge-projection (CP-002-5)")` block asserts the view source
//     NEVER imports the runtime-daemon or control-plane packages directly.
//
// Mirrors SessionBootstrap.test.tsx idioms: the `installMockBridge`
// install/teardown shape, the `afterEach` reset, and the RTL
// `render`/`screen.findBy*`/`getBy*` assertion style. The mock bridge is
// DUPLICATED here per the T6.3 standing directive — this view's bridge surface
// is `{ daemon: { call, subscribe } }` (read + subscribe), wider than
// SessionBootstrap's call-only surface, so a shared helper would not fit anyway.
//
// Vitest 4 `globals: true` (renderer project) supplies `describe`/`it`/`expect`/
// `vi`/`afterEach`; the renderer test tsconfig adds `vitest/globals` to `types`.

import { act, render, screen, waitFor } from "@testing-library/react";

import { NotImplementedAtTier1Error } from "@ai-sidekicks/contracts";
import type {
  ParticipantId,
  PresenceReadResponse,
  PresenceUpdate,
  SessionId,
  SidekicksBridge,
  Unsubscribe,
} from "@ai-sidekicks/contracts";

import { ParticipantRoster } from "../participant-roster.js";

// --------------------------------------------------------------------------
// CP-002-5 source-text read — Vite `import.meta.glob` raw form.
// --------------------------------------------------------------------------
//
// See invite-accept-view.test.tsx for the full rationale. In short: the
// bridge-projection assertion needs the view's source TEXT; Vite's
// `import.meta.glob(..., { query: "?raw" })` inlines it as a string at transform
// time with NO module import, which is the only lint-clean / typecheck-clean
// option here (`node:fs` is doubly banned — by the renderer
// `no-restricted-imports` rule and by the renderer test typegraph's `types: []`
// posture). The local `ImportMeta` augmentation declares the single signature we
// use; it is scoped to this test program and does not leak into the production
// renderer typecheck.
declare global {
  interface ImportMeta {
    glob: (
      pattern: string,
      options: { query: "?raw"; import: "default"; eager: true },
    ) => Record<string, string>;
  }
}

const rendererViewSources = import.meta.glob("../*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
});

// Branded id fixtures — `"<uuid>" as SessionId` / `as ParticipantId` mirrors the
// shipped SDK precedent (packages/client-sdk/test/membershipClient.integration.test.ts:64-70).
const KNOWN_SESSION_ID = "01970000-0000-7000-8000-0000000000a1" as SessionId;
// A SECOND session id for the session-switch test: re-rendering with a new
// `sessionId` must reset the roster to loading (not show the prior session's
// stale `loaded` roster) and re-read for the new session.
const SECOND_SESSION_ID = "01970000-0000-7000-8000-0000000000a2" as SessionId;
const PARTICIPANT_ONLINE = "01970000-0000-7000-8000-0000000000b1" as ParticipantId;
const PARTICIPANT_OFFLINE = "01970000-0000-7000-8000-0000000000b2" as ParticipantId;
const PARTICIPANT_RECONNECTING = "01970000-0000-7000-8000-0000000000b3" as ParticipantId;
const PARTICIPANT_NEW_ON_REREAD = "01970000-0000-7000-8000-0000000000b4" as ParticipantId;
// A member that belongs ONLY to SECOND_SESSION_ID's roster — used to prove the
// new session's participants eventually load after a session switch.
const PARTICIPANT_SECOND_SESSION = "01970000-0000-7000-8000-0000000000b5" as ParticipantId;

// Two snapshots so the re-read test can assert the roster updates from one to
// the other on a subscribe push. SNAPSHOT_ONE varies `state` across the
// `PresenceState` union and INCLUDES an `"offline"` member to pin Spec-002 AC2
// (an offline member renders a row, does not vanish).
const SNAPSHOT_ONE: PresenceReadResponse = {
  participants: [
    {
      participantId: PARTICIPANT_ONLINE,
      state: "online",
      lastSeen: "2026-05-26T10:00:00.000Z",
    },
    {
      participantId: PARTICIPANT_OFFLINE,
      state: "offline",
      lastSeen: "2026-05-26T09:55:00.000Z",
    },
    {
      participantId: PARTICIPANT_RECONNECTING,
      state: "reconnecting",
      lastSeen: "2026-05-26T09:58:00.000Z",
    },
  ],
};

// SNAPSHOT_TWO is what a subscribe-triggered re-read returns — an extra member
// joined and one flipped to `idle`. The re-read test asserts the roster reflects
// THIS snapshot after the captured handler fires.
const SNAPSHOT_TWO: PresenceReadResponse = {
  participants: [
    {
      participantId: PARTICIPANT_ONLINE,
      state: "idle",
      lastSeen: "2026-05-26T10:05:00.000Z",
    },
    {
      participantId: PARTICIPANT_NEW_ON_REREAD,
      state: "online",
      lastSeen: "2026-05-26T10:05:30.000Z",
    },
  ],
};

// The roster SECOND_SESSION_ID returns — a disjoint membership, so the
// session-switch test can assert the prior session's members are gone and this
// one's member is present.
const SECOND_SESSION_SNAPSHOT: PresenceReadResponse = {
  participants: [
    {
      participantId: PARTICIPANT_SECOND_SESSION,
      state: "online",
      lastSeen: "2026-05-26T11:00:00.000Z",
    },
  ],
};

// A manually-resolvable promise — lets a test hold two `presence.read` calls in
// flight and resolve them in a CHOSEN order (older last) to exercise the
// out-of-order guard. `resolve` is assigned synchronously inside the executor,
// so it is always defined by the time the test calls it.
function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function installMockBridge(
  call: ReturnType<typeof vi.fn>,
  subscribe: ReturnType<typeof vi.fn>,
): void {
  // ParticipantRoster reads `window.sidekicks.daemon.call` (presence.read) AND
  // `window.sidekicks.daemon.subscribe` (presence.subscribe) — both methods are
  // required on the mock. Mocking the other five capability groups would be
  // unnecessary scaffolding; we cast through `unknown` because the partial shape
  // is not structurally assignable to the full `SidekicksBridge`.
  const bridge: { daemon: { call: typeof call; subscribe: typeof subscribe } } = {
    daemon: { call, subscribe },
  };
  (window as unknown as { sidekicks: SidekicksBridge }).sidekicks =
    bridge as unknown as SidekicksBridge;
}

// A no-op `Unsubscribe` for tests that do not assert on cleanup. The unmount
// test below uses a dedicated `vi.fn()` spy instead.
const noopUnsubscribe: Unsubscribe = () => {};

describe("ParticipantRoster (Plan-002 Phase 6 T6.3)", () => {
  afterEach(() => {
    delete (window as unknown as { sidekicks?: SidekicksBridge }).sidekicks;
    vi.clearAllMocks();
  });

  it("renders the loading indicator before the initial presence.read resolves", () => {
    // Mount-triggered view: it STARTS in `loading` (the read fires on mount).
    // An un-settling read keeps it in `loading` so the synchronous `getByLabelText`
    // observes the in-flight branch before any microtask flush moves it on.
    const daemonCall = vi.fn(() => new Promise(() => {}));
    const daemonSubscribe = vi.fn(() => noopUnsubscribe);
    installMockBridge(daemonCall, daemonSubscribe);

    render(<ParticipantRoster sessionId={KNOWN_SESSION_ID} />);

    const loadingSection = screen.getByLabelText("participant-roster-loading");
    expect(loadingSection).toBeDefined();
    expect(loadingSection.getAttribute("aria-busy")).toBe("true");
    // The mount read fired for this session.
    expect(daemonCall).toHaveBeenCalledWith("presence.read", { sessionId: KNOWN_SESSION_ID });
  });

  it("renders one row per participant once the snapshot loads, including an offline member", async () => {
    // Spec-002 §AC1 (roster renders joined participants) + §AC2 (offline member
    // renders a row, does not vanish). SNAPSHOT_ONE has an `"offline"` member.
    const daemonCall = vi.fn().mockResolvedValue(SNAPSHOT_ONE);
    const daemonSubscribe = vi.fn(() => noopUnsubscribe);
    installMockBridge(daemonCall, daemonSubscribe);

    render(<ParticipantRoster sessionId={KNOWN_SESSION_ID} />);

    const loadedSection = await screen.findByLabelText("participant-roster-loaded");
    expect(loadedSection).toBeDefined();

    // One row per participant (each is an <li>); count matches the snapshot.
    const rows = loadedSection.querySelectorAll("li");
    expect(rows.length).toBe(SNAPSHOT_ONE.participants.length);

    // Each participant's id + presence state + last-seen render.
    for (const participant of SNAPSHOT_ONE.participants) {
      expect(loadedSection.textContent).toContain(`participant id: ${participant.participantId}`);
      expect(loadedSection.textContent).toContain(`presence: ${participant.state}`);
      expect(loadedSection.textContent).toContain(`last seen: ${participant.lastSeen}`);
    }

    // AC2 durability surface, asserted explicitly: the offline member is present
    // with an `offline` indicator, not dropped.
    expect(loadedSection.textContent).toContain("presence: offline");
    expect(loadedSection.textContent).toContain(`participant id: ${PARTICIPANT_OFFLINE}`);
  });

  it("subscribes to presence.subscribe and re-reads presence on each push", async () => {
    // Option-C design: the subscribe handler treats each `PresenceUpdate` as an
    // OPAQUE change-signal and re-invokes `presence.read` to refresh the decoded
    // roster. We capture the handler passed to `daemon.subscribe`, then invoke it
    // to simulate a push and assert (a) `presence.read` is called AGAIN and (b)
    // the roster updates to the second snapshot.
    let capturedHandler: ((payload: PresenceUpdate) => void) | undefined;
    const daemonSubscribe = vi.fn(
      (_event: string, handler: (payload: PresenceUpdate) => void): Unsubscribe => {
        capturedHandler = handler;
        return noopUnsubscribe;
      },
    );
    // First `presence.read` → SNAPSHOT_ONE; the re-read after the push → SNAPSHOT_TWO.
    const daemonCall = vi
      .fn()
      .mockResolvedValueOnce(SNAPSHOT_ONE)
      .mockResolvedValueOnce(SNAPSHOT_TWO);
    installMockBridge(daemonCall, daemonSubscribe);

    render(<ParticipantRoster sessionId={KNOWN_SESSION_ID} />);

    // Initial snapshot rendered.
    await screen.findByText(`participant id: ${PARTICIPANT_ONLINE}`);
    expect(daemonSubscribe).toHaveBeenCalledTimes(1);
    expect(daemonSubscribe).toHaveBeenCalledWith("presence.subscribe", expect.any(Function));
    expect(capturedHandler).toBeDefined();
    expect(daemonCall).toHaveBeenCalledTimes(1);

    // Simulate a presence push. The payload is an opaque change-signal the view
    // ignores, so a minimal stand-in is sufficient; the act is the re-read it
    // triggers. Wrapping in a typed object keeps the captured-handler signature
    // honest without asserting on the (unused) payload.
    capturedHandler?.({
      sessionId: KNOWN_SESSION_ID,
      awarenessState: new Uint8Array(),
    });

    // No-flicker backstop (participant-roster.tsx:155-160 — the load-bearing
    // contract that a subscribe-triggered re-read updates IN PLACE and NEVER
    // flashes back to `loading`). SYNCHRONOUSLY — before the `await` below — the
    // view must still show the loaded section and must NOT have re-entered the
    // loading branch. This is non-flaky precisely because the re-read's `loaded`
    // setState is a microtask that has NOT flushed at this synchronous point, so
    // the view is still showing SNAPSHOT_ONE's loaded section; a regression that
    // re-set `{ kind: "loading" }` at the top of the re-read would be caught HERE.
    // Without this, the post-push `findByText` retry would mask a mid-re-read
    // loading flash (it just waits until SNAPSHOT_TWO eventually appears).
    expect(screen.getByLabelText("participant-roster-loaded")).toBeDefined();
    expect(screen.queryByLabelText("participant-roster-loading")).toBeNull();

    // The re-read returns SNAPSHOT_TWO; the roster updates IN PLACE to it.
    const newMemberRow = await screen.findByText(`participant id: ${PARTICIPANT_NEW_ON_REREAD}`);
    expect(newMemberRow).toBeDefined();
    // A second `presence.read` fired (the re-read on the push).
    expect(daemonCall).toHaveBeenCalledTimes(2);
    expect(daemonCall).toHaveBeenNthCalledWith(2, "presence.read", {
      sessionId: KNOWN_SESSION_ID,
    });
    // The roster no longer shows a member that left in the new snapshot.
    expect(screen.queryByText(`participant id: ${PARTICIPANT_OFFLINE}`)).toBeNull();
  });

  it("installs the presence.subscribe subscription before the initial presence.read", async () => {
    // Subscribe-BEFORE-initial-read ordering (participant-roster.tsx — the
    // effect installs `daemon.subscribe` first, THEN fires the initial
    // `presence.read`). A change landing in the window between the snapshot and
    // the subscription would otherwise be lost. Both calls happen synchronously
    // within the effect, so asserting the call COUNT alone cannot discriminate
    // the order — we compare Vitest's `invocationCallOrder` (a monotonic global
    // counter stamped on every mock call) to prove `subscribe` was invoked
    // before `call`.
    const daemonCall = vi.fn().mockResolvedValue(SNAPSHOT_ONE);
    const daemonSubscribe = vi.fn(() => noopUnsubscribe);
    installMockBridge(daemonCall, daemonSubscribe);

    render(<ParticipantRoster sessionId={KNOWN_SESSION_ID} />);

    // Both fired during the mount effect.
    expect(daemonSubscribe).toHaveBeenCalledTimes(1);
    expect(daemonCall).toHaveBeenCalledTimes(1);
    // The subscribe's invocation order is strictly lower than the read's —
    // subscribe ran first. This is the direct ordering proof. Narrowing throws
    // (mirroring this file's `participantRosterSource` guard) turn the
    // `noUncheckedIndexedAccess` `number | undefined` into `number` and document
    // the call-count invariant asserted just above.
    const subscribeOrder = daemonSubscribe.mock.invocationCallOrder[0];
    const readOrder = daemonCall.mock.invocationCallOrder[0];
    if (subscribeOrder === undefined || readOrder === undefined) {
      throw new Error("expected both daemon.subscribe and daemon.call to have recorded a call");
    }
    expect(subscribeOrder).toBeLessThan(readOrder);

    // Sanity: the snapshot still loads (ordering did not break the read path).
    await screen.findByLabelText("participant-roster-loaded");
  });

  it("renders the newer presence.read result when two reads resolve out of order", async () => {
    // Out-of-order guard (participant-roster.tsx `latestRequestSequence`). Rapid
    // subscribe pushes can leave multiple `presence.read` calls in flight at
    // once; the bridge gives no resolution-order guarantee. Here the INITIAL
    // read (older) and a subscribe-triggered re-read (newer) are both in flight,
    // and the OLDER one resolves LAST. The roster must reflect the NEWER result,
    // not let the stale older result overwrite it. The `cancelled` flag does NOT
    // cover this — it only guards unmount — so a regression that dropped the
    // sequence guard would render the stale snapshot here.
    const firstRead = createDeferred<PresenceReadResponse>();
    const secondRead = createDeferred<PresenceReadResponse>();
    const daemonCall = vi
      .fn()
      .mockReturnValueOnce(firstRead.promise)
      .mockReturnValueOnce(secondRead.promise);

    // Capture the subscribe handler so the test can fire a push deterministically.
    let capturedHandler: ((payload: PresenceUpdate) => void) | undefined;
    const daemonSubscribe = vi.fn(
      (_event: string, handler: (payload: PresenceUpdate) => void): Unsubscribe => {
        capturedHandler = handler;
        return noopUnsubscribe;
      },
    );
    installMockBridge(daemonCall, daemonSubscribe);

    render(<ParticipantRoster sessionId={KNOWN_SESSION_ID} />);

    // The initial read (sequence 1) is in flight but unresolved. Fire a push to
    // trigger the re-read (sequence 2), also in flight and unresolved.
    expect(capturedHandler).toBeDefined();
    capturedHandler?.({ sessionId: KNOWN_SESSION_ID, awarenessState: new Uint8Array() });
    expect(daemonCall).toHaveBeenCalledTimes(2);

    // Resolve the NEWER read (sequence 2 → SNAPSHOT_TWO) FIRST, then the OLDER
    // read (sequence 1 → SNAPSHOT_ONE) LAST. The stale older result must be
    // discarded by the sequence guard.
    secondRead.resolve(SNAPSHOT_TWO);
    await screen.findByText(`participant id: ${PARTICIPANT_NEW_ON_REREAD}`);

    firstRead.resolve(SNAPSHOT_ONE);

    // The roster still shows the NEWER snapshot. The older read resolving last
    // is a no-op: SNAPSHOT_ONE-only members never appear, and SNAPSHOT_TWO's new
    // member stays. `waitFor` lets any (erroneous) stale setState flush before we
    // assert — without the guard this would flip to SNAPSHOT_ONE and fail.
    await waitFor(() => {
      expect(screen.queryByText(`participant id: ${PARTICIPANT_OFFLINE}`)).toBeNull();
    });
    expect(screen.getByText(`participant id: ${PARTICIPANT_NEW_ON_REREAD}`)).toBeDefined();
    expect(screen.queryByText(`participant id: ${PARTICIPANT_RECONNECTING}`)).toBeNull();
  });

  it("resets to loading on a sessionId change and loads the new session's roster", async () => {
    // Session-switch reset (participant-roster.tsx — the render-phase
    // `previousSessionId` guard that sets `loading` on a `sessionId` change). A
    // switch must transiently show loading, NOT the prior session's stale
    // `loaded` roster, and must re-read for the new session. The new session's
    // read is held un-settled so the loading branch is observable after the
    // re-render (an immediately-resolved read could flush to `loaded` first).
    //
    // This is an END-STATE check, not a frame-timing one: after the rerender,
    // the view shows loading (prior session's roster gone), then loads the new
    // session once its read resolves. The render-phase reset itself (vs an
    // effect-body reset that would commit one stale frame first) is documented
    // and motivated where it lives — the `previousSessionId` block in the
    // component; it is NOT separately observable here, because React Testing
    // Library's `act()` flushes every commit before `rerender` returns, so JSDOM
    // never exposes an intermediate stale-paint commit to a post-rerender assert.
    const secondRead = createDeferred<PresenceReadResponse>();
    const daemonCall = vi
      .fn()
      .mockResolvedValueOnce(SNAPSHOT_ONE) // session 1 initial read
      .mockReturnValueOnce(secondRead.promise); // session 2 initial read (held)
    const daemonSubscribe = vi.fn(() => noopUnsubscribe);
    installMockBridge(daemonCall, daemonSubscribe);

    // Session 1: load its roster fully.
    const { rerender } = render(<ParticipantRoster sessionId={KNOWN_SESSION_ID} />);
    await screen.findByLabelText("participant-roster-loaded");
    expect(screen.getByText(`participant id: ${PARTICIPANT_ONLINE}`)).toBeDefined();

    // Switch to session 2. The render-phase guard resets to loading as part of
    // committing the new props; the new session's read is in flight (held).
    rerender(<ParticipantRoster sessionId={SECOND_SESSION_ID} />);

    // The loading branch shows during the new read, and the PRIOR session's
    // participants are NOT rendered during the transition.
    await waitFor(() => {
      expect(screen.getByLabelText("participant-roster-loading")).toBeDefined();
    });
    expect(screen.queryByLabelText("participant-roster-loaded")).toBeNull();
    expect(screen.queryByText(`participant id: ${PARTICIPANT_ONLINE}`)).toBeNull();

    // The re-read fired for the NEW session.
    expect(daemonCall).toHaveBeenNthCalledWith(2, "presence.read", {
      sessionId: SECOND_SESSION_ID,
    });

    // Once the new session's read resolves, its roster loads in place.
    secondRead.resolve(SECOND_SESSION_SNAPSHOT);
    await screen.findByText(`participant id: ${PARTICIPANT_SECOND_SESSION}`);
    expect(screen.queryByText(`participant id: ${PARTICIPANT_ONLINE}`)).toBeNull();
  });

  it("calls the Unsubscribe returned by subscribe exactly once on unmount", () => {
    // LOAD-BEARING cleanup test — the most important lifecycle guarantee of this
    // view. The effect must release the daemon subscription on teardown. We mock
    // `daemon.subscribe` to return a spy and assert the spy fires once on unmount.
    const unsubscribeSpy = vi.fn();
    const daemonCall = vi.fn(() => new Promise(() => {}));
    const daemonSubscribe = vi.fn((): Unsubscribe => unsubscribeSpy);
    installMockBridge(daemonCall, daemonSubscribe);

    const { unmount } = render(<ParticipantRoster sessionId={KNOWN_SESSION_ID} />);
    expect(daemonSubscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribeSpy).not.toHaveBeenCalled();

    unmount();

    expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
  });

  it("renders the error envelope when presence.read rejects asynchronously", async () => {
    // Async-rejection branch on the initial read — the Tier-1 production path
    // rejects with `NotImplementedAtTier1Error`. The view surfaces the
    // `role="alert"` envelope and is not stranded in loading.
    const tier1Error = new NotImplementedAtTier1Error("presence.read");
    const daemonCall = vi.fn().mockRejectedValue(tier1Error);
    const daemonSubscribe = vi.fn(() => noopUnsubscribe);
    installMockBridge(daemonCall, daemonSubscribe);

    render(<ParticipantRoster sessionId={KNOWN_SESSION_ID} />);

    const errorSection = await screen.findByLabelText("participant-roster-error");
    expect(errorSection).toBeDefined();
    expect(errorSection.getAttribute("role")).toBe("alert");
    expect(errorSection.textContent).toContain("NotImplementedAtTier1Error");
    expect(errorSection.textContent).toContain("presence.read");
    expect(screen.queryByLabelText("participant-roster-loading")).toBeNull();
  });

  it("renders the error envelope when presence.read throws synchronously", async () => {
    // LOAD-BEARING sync-throw case on the read path. At Tier 1, `daemon.call`
    // throws SYNCHRONOUSLY (`() => tier1Throw("daemon.call")`). The view's
    // `refreshSnapshot` wraps the call in a void async IIFE so `await` funnels the
    // sync throw into the same `catch` as an async rejection — a regression that
    // bypassed that would let the throw escape and strand the view in loading.
    const tier1Error = new NotImplementedAtTier1Error("presence.read");
    const daemonCall = vi.fn(() => {
      throw tier1Error;
    });
    const daemonSubscribe = vi.fn(() => noopUnsubscribe);
    installMockBridge(daemonCall, daemonSubscribe);

    render(<ParticipantRoster sessionId={KNOWN_SESSION_ID} />);

    const errorSection = await screen.findByLabelText("participant-roster-error");
    expect(errorSection).toBeDefined();
    expect(errorSection.getAttribute("role")).toBe("alert");
    expect(errorSection.textContent).toContain("NotImplementedAtTier1Error");
    expect(screen.queryByLabelText("participant-roster-loading")).toBeNull();
  });

  it("renders the error envelope when presence.subscribe throws synchronously", async () => {
    // LOAD-BEARING sync-throw case on the SUBSCRIBE path. The synchronous
    // `subscribePresence(...)` call has its OWN `try/catch` in the effect because
    // at Tier 1 it throws synchronously (`() => tier1Throw("daemon.subscribe")`);
    // an uncaught throw there would crash the effect callback (React does not
    // catch effect-callback throws) and strand the view. This case proves that
    // catch drives the error state.
    //
    // The initial `refreshSnapshot()` lives INSIDE the subscribe `try`, AFTER the
    // subscribe assignment — so a synchronous subscribe-throw jumps straight to
    // the catch and the read is NEVER reached. We assert exactly that: the read
    // mock is arranged to fail the test if it is ever invoked, and we verify it
    // was not called. (No never-settling-read contortion is needed: the read does
    // not run at all on a subscribe-throw, so there is no late `loaded` setState
    // that could clobber the error — see the no-clobber test below.)
    const subscribeError = new NotImplementedAtTier1Error("presence.subscribe");
    const daemonCall = vi.fn(() => {
      throw new Error("presence.read must not be called when subscribe throws");
    });
    const daemonSubscribe = vi.fn(() => {
      throw subscribeError;
    });
    installMockBridge(daemonCall, daemonSubscribe);

    render(<ParticipantRoster sessionId={KNOWN_SESSION_ID} />);

    const errorSection = await screen.findByLabelText("participant-roster-error");
    expect(errorSection).toBeDefined();
    expect(errorSection.getAttribute("role")).toBe("alert");
    expect(errorSection.textContent).toContain("NotImplementedAtTier1Error");
    expect(errorSection.textContent).toContain("presence.subscribe");
    // The subscribe was attempted, the read was gated out by the subscribe-throw,
    // and the view is not stranded in loading.
    expect(daemonSubscribe).toHaveBeenCalledTimes(1);
    expect(daemonCall).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("participant-roster-loading")).toBeNull();
  });

  it("holds the subscribe-throw error and never flips to loaded when the read later resolves", async () => {
    // No-clobber outcome: distinct failure mode from the test above. That test
    // pins that the read is never INVOKED on a subscribe-throw (`daemonCall` not
    // called); this one pins the user-visible CONSEQUENCE of the gate — that the
    // error envelope HOLDS and the view never flips to `loaded`. We arrange a read
    // that resolves a VALID snapshot, resolve it AFTER the subscribe-throw error
    // is on screen, and assert the error still holds.
    //
    // The resolve is wrapped in `act` so that IF a read were in flight (the bug),
    // its `await`-resumed `setRosterState({ loaded })` would commit before we
    // assert — making this a genuine discriminator. Verified empirically: with the
    // read gated out (the fix) the error holds; with the initial read ungated (the
    // bug), the resolved snapshot drives a `loaded` commit and this fails — which
    // is the exact mislead being prevented: a static snapshot with no live channel.
    const subscribeError = new NotImplementedAtTier1Error("presence.subscribe");
    const heldRead = createDeferred<PresenceReadResponse>();
    const daemonCall = vi.fn(() => heldRead.promise);
    const daemonSubscribe = vi.fn(() => {
      throw subscribeError;
    });
    installMockBridge(daemonCall, daemonSubscribe);

    render(<ParticipantRoster sessionId={KNOWN_SESSION_ID} />);

    const errorSection = await screen.findByLabelText("participant-roster-error");
    expect(errorSection.textContent).toContain("presence.subscribe");

    await act(async () => {
      heldRead.resolve(SNAPSHOT_ONE);
    });

    expect(screen.getByLabelText("participant-roster-error")).toBeDefined();
    expect(screen.queryByLabelText("participant-roster-loaded")).toBeNull();
    expect(screen.queryByText(`participant id: ${PARTICIPANT_ONLINE}`)).toBeNull();
  });

  describe("bridge-projection (CP-002-5)", () => {
    // Spec-023 §Trust Stance + Plan-002 CP-002-5 operational enforcement. The
    // renderer is the UNTRUSTED surface: it must reach the daemon / control-plane
    // ONLY through the `window.sidekicks` preload bridge, NEVER by importing the
    // node-side packages directly. This assertion reads the view's own source
    // text (via the Vite `import.meta.glob` raw form declared inline above — a
    // lint-clean / typecheck-clean alternative to `node:fs`, which is doubly
    // banned in renderer source: by `no-restricted-imports` AND by the renderer
    // test typegraph's `types: []`/no-`@types/node` posture) and asserts no
    // import statement targets the banned packages.
    //
    // THIS IS THE SOLE OPERATIONAL ENFORCEMENT of the daemon/control-plane import
    // ban for renderer source: `apps/desktop/eslint.config.mjs` bans `electron` /
    // `node:*` / `main`/`preload` escapes, but the `@ai-sidekicks/runtime-daemon`
    // / `@ai-sidekicks/control-plane` ban is deferred to the Plan-023 Tier 8
    // remainder (those would be inert today). Until that lands, this regex tripwire
    // is the only thing that turns CI red on a direct import — so it must catch
    // EVERY realistic direct-import shape, not just the bare-exact form.
    //
    // The four regexes below cover (identical set to invite-accept-view.test.tsx):
    //   1. `bannedBareImport` — `from "@ai-sidekicks/<pkg>"` AND any subpath
    //      (`from "@ai-sidekicks/<pkg>/internal"`) — the optional `(?:/…)?` group
    //      is what closes the subpath-evasion gap a trailing-quote-only anchor left.
    //   2. `bannedRelativeImport` — `from "…/packages/<pkg>/…"` (exact or subpath).
    //   3. `bannedSideEffectImport` — a `from`-less side-effect import
    //      (`import "@ai-sidekicks/<pkg>"` or its relative form). A REAL gap for
    //      control-plane, which (unlike runtime-daemon's native bindings) pulls
    //      nothing that would crash on a bare side-effect import.
    //   4. `bannedDynamicImport` — `import("@ai-sidekicks/<pkg>")` (or relative).
    // where `<pkg>` is `runtime-daemon | control-plane`.
    //
    // All four anchor on the IMPORT SURFACE (`from "…"` / `import "…"` /
    // `import("…")`), NOT bare words: participant-roster.tsx mentions "the local
    // daemon" / "daemon → client" in PROSE comments, which a naive substring on
    // the package nickname would false-positive. The set is verified empirically
    // in the implementer's report: all violation shapes match; allowed imports
    // (`react`, `@testing-library/react`, type-only `@ai-sidekicks/contracts`) and
    // prose do not.
    const bannedBareImport =
      /from\s*["'`]@ai-sidekicks\/(?:runtime-daemon|control-plane)(?:\/[^"'`]*)?["'`]/;
    const bannedRelativeImport = /from\s*["'`][^"'`]*packages\/(?:runtime-daemon|control-plane)\//;
    const bannedSideEffectImport =
      /import\s*["'`](?:@ai-sidekicks\/(?:runtime-daemon|control-plane)(?:\/[^"'`]*)?|[^"'`]*packages\/(?:runtime-daemon|control-plane)\/[^"'`]*)["'`]/;
    const bannedDynamicImport =
      /import\s*\(\s*["'`](?:@ai-sidekicks\/(?:runtime-daemon|control-plane)(?:\/[^"'`]*)?|[^"'`]*packages\/(?:runtime-daemon|control-plane)\/[^"'`]*)["'`]/;
    // `[patternName, pattern]` tuples drive the `it.each` below. Naming each
    // pattern means a future regression reports WHICH shape matched (the case
    // title interpolates the name) instead of a bare `expected true to be false`
    // that forces a manual bisect across the four regexes.
    const bannedDirectImportPatterns: ReadonlyArray<readonly [string, RegExp]> = [
      ["bannedBareImport", bannedBareImport],
      ["bannedRelativeImport", bannedRelativeImport],
      ["bannedSideEffectImport", bannedSideEffectImport],
      ["bannedDynamicImport", bannedDynamicImport],
    ];

    // Glob-key-drift guard, hoisted to run ONCE before the `it.each`: if the
    // `import.meta.glob` key ever drifts, this throws loudly here rather than
    // letting every case vacuously pass against an `undefined` source. After the
    // narrowing throw, `participantRosterSource` is `string` for all cases below.
    const participantRosterSource = rendererViewSources["../participant-roster.tsx"];
    if (typeof participantRosterSource !== "string") {
      throw new Error("participant-roster.tsx source was not loaded by import.meta.glob");
    }

    it.each(bannedDirectImportPatterns)(
      "participant-roster.tsx source matches no %s direct daemon/control-plane import",
      (_bannedImportPatternName, bannedImportPattern) => {
        expect(bannedImportPattern.test(participantRosterSource)).toBe(false);
      },
    );
  });
});
