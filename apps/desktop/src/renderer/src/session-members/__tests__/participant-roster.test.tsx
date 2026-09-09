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
//   • Spec-023 §Trust Stance (bridge-projection / CP-002-5) is enforced by
//     `apps/desktop/eslint.config.mjs`, which bans the runtime-daemon and
//     control-plane packages from renderer source at `error`.
//
// Mirrors SessionBootstrap.test.tsx idioms: the `installMockBridge`
// install/teardown shape, the `afterEach` reset, and the RTL
// `render`/`screen.findBy*`/`getBy*` assertion style. The mock bridge is
// DUPLICATED from that suite per the T6.3 standing directive — this view's bridge
// surface is `{ daemon: { call, subscribe } }` (read + subscribe), wider than
// SessionBootstrap's call-only surface, so a shared helper would not fit anyway. It
// lives in `participant-roster.test-support.ts`, which the two suites here share.
//
// Vitest 4 `globals: true` (renderer project) supplies `describe`/`it`/`expect`/
// `vi`/`afterEach`; the renderer test tsconfig adds `vitest/globals` to `types`.
//
// SPLIT ON ITS SEAMS, WHICH IS THE ONLY REASON A FILE IS SPLIT. This file carried the
// scaffolding, the lifecycle cases and the failure cases in one program — three jobs,
// and two of them left. The scaffolding is `participant-roster.test-support.ts` and
// the refusal surfacing is `participant-roster.failures.test.tsx`. What stays here is
// the view's own lifecycle: what it renders, what it reads, what it subscribes to, and
// what it releases.

import { render, screen, waitFor } from "@testing-library/react";

import type { PresenceReadResponse, PresenceUpdate, Unsubscribe } from "@ai-sidekicks/contracts";

import { ParticipantRoster } from "../participant-roster.js";
import {
  KNOWN_SESSION_ID,
  PARTICIPANT_NEW_ON_REREAD,
  PARTICIPANT_OFFLINE,
  PARTICIPANT_ONLINE,
  PARTICIPANT_RECONNECTING,
  PARTICIPANT_SECOND_SESSION,
  SECOND_SESSION_ID,
  SECOND_SESSION_SNAPSHOT,
  SNAPSHOT_ONE,
  SNAPSHOT_TWO,
  createDeferred,
  installMockBridge,
  noopUnsubscribe,
  removeMockBridge,
} from "./participant-roster.test-support.js";

// Component under test: `ParticipantRoster` (Plan-002 Phase 6 T6.3).
describe("ParticipantRoster", () => {
  afterEach(() => {
    removeMockBridge();
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
});
