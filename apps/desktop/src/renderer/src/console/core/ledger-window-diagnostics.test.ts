// What the ledger-window registry answers, and the one ordering that decides it.
//
// The registry is three lines of behaviour and one of them is load-bearing: a route
// change mounts the next ledger before React runs the outgoing one's cleanup, so the
// unregister a mount is handed has to remove ITS reader and not whichever one is
// current. A blind delete there leaves the session reporting no viewport for the rest
// of the window's life — silently, and only after a remount, which is precisely the
// state the endurance tier is asking about when it reads this.

import { describe, expect, it } from "vitest";

import {
  LedgerWindowDiagnosticsRegistry,
  type LedgerWindowReading,
} from "./ledger-window-diagnostics.js";

const SESSION_ID = "session-under-test";

function reading(mountedRowCount: number): LedgerWindowReading {
  return {
    virtualItemCount: mountedRowCount,
    mountedRowCount,
    totalRowCount: 200,
    indexableRowCount: 200,
    visibleRowCount: 5,
    totalContentHeightPx: 10_000,
    viewportClientHeightPx: 400,
    viewportScrollHeightPx: 10_000,
    rangedAgainstClientHeightPx: 400,
  };
}

describe("the ledger window diagnostics registry", () => {
  it("answers with the reading the mounted viewport takes when it is asked", () => {
    const registry = new LedgerWindowDiagnosticsRegistry();
    let mountedRowCount = 11;
    registry.register(SESSION_ID, () => reading(mountedRowCount));

    // Read TWICE across a change, because the whole shape rests on the reader being
    // called at the moment of the question: a registry that captured a value at
    // registration would answer with the window as it was when the pane mounted.
    expect(registry.readingFor(SESSION_ID)?.mountedRowCount).toBe(11);
    mountedRowCount = 17;
    expect(registry.readingFor(SESSION_ID)?.mountedRowCount).toBe(17);
  });

  it("negative control: a session with no viewport mounted answers with nothing", () => {
    const registry = new LedgerWindowDiagnosticsRegistry();

    expect(registry.readingFor(SESSION_ID)).toBeNull();
  });

  it("keeps the incoming mount's reader when the outgoing mount's cleanup runs late", () => {
    const registry = new LedgerWindowDiagnosticsRegistry();
    const retireOutgoing = registry.register(SESSION_ID, () => reading(1));
    // The remount, before the cleanup — which is the order React uses on a route
    // change and the reason the retire below must not be a blind delete.
    registry.register(SESSION_ID, () => reading(2));

    retireOutgoing();

    expect(registry.readingFor(SESSION_ID)?.mountedRowCount).toBe(2);
  });

  it("negative control: retiring the current reader does remove it", () => {
    // Without this the identity check above would pass over a registry that never
    // removes anything at all, which would report a viewport for a session whose
    // ledger has been unmounted for hours.
    const registry = new LedgerWindowDiagnosticsRegistry();
    const retire = registry.register(SESSION_ID, () => reading(1));

    retire();

    expect(registry.readingFor(SESSION_ID)).toBeNull();
  });
});
