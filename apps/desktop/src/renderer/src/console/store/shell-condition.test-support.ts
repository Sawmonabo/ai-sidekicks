// The shell conditions a surface is driven under.
//
// One copy of "the supervisor said it is stopped", so two suites cannot disagree about
// which condition they assert against. It sits in `store/`, the lowest family every reader
// is above, because view families are siblings and cannot reach a helper in another one.
//
// A REPORT AND NOT A HAND-BUILT STATE. `FrameStore.publishShellReport` is the writer the
// shipped supervisor binding uses, so a case driving it exercises the same fold a window
// does; a state assembled by hand would assert against a shape nothing publishes.

import { FrameStore, type ShellState } from "./index.js";

/** A supervisor reporting a healthy runtime. */
const CONNECTED_REPORT: ShellState = {
  connection: { kind: "connected" },
  negotiation: undefined,
  lastHeartbeatAt: "2026-01-01T10:00:00.000Z",
  transport: "os-local",
  keystore: "available",
};

/**
 * A frame store whose shell has reported nothing.
 *
 * Silence is not an outage, so this is the ordinary condition. Named rather than
 * constructed inline so the suites agree on what "ordinary" means.
 */
export function quietShell(): FrameStore {
  return new FrameStore();
}

/** A supervisor reporting the local runtime turned off. */
const STOPPED_REPORT: ShellState = { ...CONNECTED_REPORT, connection: { kind: "stopped" } };

/**
 * A frame store whose supervisor has reported the local runtime stopped.
 *
 * `stopped` rather than `offline` because it is the arm a person can act on: the runtime
 * was turned off and can be started again.
 */
export function stoppedShell(): FrameStore {
  const store = new FrameStore();
  stopShell(store);
  return store;
}

/**
 * Report the runtime stopped on a store a surface is ALREADY mounted against.
 *
 * The condition {@link stoppedShell} builds, arriving in the order a real outage arrives
 * in: after the surface rendered.
 */
function stopShell(store: FrameStore): void {
  store.publishShellReport(STOPPED_REPORT);
}
