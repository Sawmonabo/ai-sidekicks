// The shell conditions a mutating surface is driven under.
//
// BESIDE THE MODULE THAT DERIVES THE BLOCK, which is the lowest family every reader
// sits above. It began at the collaboration family's root, on `repos/
// pane-contexts.test-support.ts`' reasoning — both `invites/` and `members/` dispatch a
// daemon write and both disable their controls from the same seam, so a second copy of
// "the supervisor said it is stopped" would let two suites disagree about which
// condition they are asserting against. The ledger's ask answer is the third dispatcher
// on that seam and view families are siblings, so it could not reach a helper living in
// another one: the hoist is `apps/desktop/AGENTS.md`'s own rule for a helper's second
// family, and the alternative was exactly the second spelling this file exists to stop.
//
// A REPORT AND NOT A HAND-BUILT STATE. `FrameStore.publishShellReport` is the writer
// the shipped supervisor binding uses, so a case driving it exercises the same fold a
// window does; a state assembled by hand would assert against a shape nothing publishes.

import { FrameStore, type ShellReport } from "./index.js";

/** A supervisor reporting a healthy runtime: the condition that closes no control. */
const CONNECTED_REPORT: ShellReport = {
  connection: { kind: "connected" },
  negotiation: undefined,
  lastHeartbeatAt: "2026-01-01T10:00:00.000Z",
  transport: "os-local",
  keystore: "available",
};

/**
 * A frame store whose shell has reported nothing.
 *
 * That is the state which closes no control — silence is not an outage — so it is the
 * condition every case about a ledger's READ and about one-mutation-at-a-time is
 * written under. Named rather than constructed inline at every site so the suites
 * cannot come to disagree about which shell condition "ordinary" means.
 */
export function quietShell(): FrameStore {
  return new FrameStore();
}

/** A frame store whose supervisor has reported the local runtime connected. */
export function connectedShell(): FrameStore {
  const store = new FrameStore();
  store.publishShellReport(CONNECTED_REPORT);
  return store;
}

/** A supervisor reporting the local runtime turned off. */
const STOPPED_REPORT: ShellReport = { ...CONNECTED_REPORT, connection: { kind: "stopped" } };

/**
 * A frame store whose supervisor has reported the local runtime stopped.
 *
 * `stopped` rather than `offline` because it is the arm a person can act on — the
 * runtime was turned off, and the banner offers to start it again — so a control
 * closed under it is closed for a reason the surface can state.
 */
export function stoppedShell(): FrameStore {
  const store = new FrameStore();
  stopShell(store);
  return store;
}

/**
 * Report the runtime stopped on a store a surface is ALREADY mounted against.
 *
 * The condition {@link stoppedShell} builds, arriving in the order a real outage
 * arrives in: after a render that offered the controls. A case driving this is asking
 * what a handler does with a block its own render never saw — which is the only way to
 * observe the window between a report landing and React catching up with it, and the
 * window every dispatch-time re-read exists to close.
 */
export function stopShell(store: FrameStore): void {
  store.publishShellReport(STOPPED_REPORT);
}

/**
 * Report the runtime serving again on a store that was stopped.
 *
 * The other half of {@link stopShell}, for the case that asks what an outage leaves
 * behind once it is over: a control that re-opens, and a sentence that goes away — or
 * one that does not, which is the defect a recovery case exists to catch.
 */
export function serveShell(store: FrameStore): void {
  store.publishShellReport(CONNECTED_REPORT);
}
