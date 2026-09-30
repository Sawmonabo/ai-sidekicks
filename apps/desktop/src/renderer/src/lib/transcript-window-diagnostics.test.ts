// The load-bearing ordering: a route change mounts the next transcript before React runs the
// outgoing cleanup, so an unregister must remove its own reader, not the current one. A blind
// delete would leave the session reporting no viewport, silently, after a remount.

import { describe, expect, it } from "vitest";

import {
  TranscriptWindowDiagnosticsRegistry,
  type TranscriptWindowReading,
} from "./transcript-window-diagnostics.js";

const SESSION_ID = "session-under-test";

function reading(mountedRowCount: number): TranscriptWindowReading {
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

describe("the transcript window diagnostics registry", () => {
  it("answers with the reading the mounted viewport takes when it is asked", () => {
    const registry = new TranscriptWindowDiagnosticsRegistry();
    let mountedRowCount = 11;
    registry.register(SESSION_ID, () => reading(mountedRowCount));

    // Read twice across a change: a registry that captured a value at registration would answer
    // with the window as it was at mount.
    expect(registry.readingFor(SESSION_ID)?.mountedRowCount).toBe(11);
    mountedRowCount = 17;
    expect(registry.readingFor(SESSION_ID)?.mountedRowCount).toBe(17);
  });

  it("negative control: a session with no viewport mounted answers with nothing", () => {
    const registry = new TranscriptWindowDiagnosticsRegistry();

    expect(registry.readingFor(SESSION_ID)).toBeNull();
  });

  it("keeps the incoming mount's reader when the outgoing mount's cleanup runs late", () => {
    const registry = new TranscriptWindowDiagnosticsRegistry();
    const retireOutgoing = registry.register(SESSION_ID, () => reading(1));
    // The remount registers before the cleanup, as React orders a route change.
    registry.register(SESSION_ID, () => reading(2));

    retireOutgoing();

    expect(registry.readingFor(SESSION_ID)?.mountedRowCount).toBe(2);
  });

  it("negative control: retiring the current reader does remove it", () => {
    // Without this, the identity check above would pass for a registry that never removes anything.
    const registry = new TranscriptWindowDiagnosticsRegistry();
    const retire = registry.register(SESSION_ID, () => reading(1));

    retire();

    expect(registry.readingFor(SESSION_ID)).toBeNull();
  });
});
