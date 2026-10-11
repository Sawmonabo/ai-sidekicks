// A selection settled in the conversation reaches the system's primary selection on Linux, the
// one system that keeps one, against what it held when the selection settled, its text sent in
// pieces that are let go once written, and writes nothing elsewhere.

import { describe, expect, it, vi } from "vitest";

import { EMPTY_SESSION_SCENARIO } from "#fixtures/scenarios/empty-session.js";
import { piecedTextOf, TEXT_PIECE_LENGTH } from "#renderer/lib/text-pieces.js";
import { TASKS_AT_ONCE } from "#test/helpers/tasks-at-once.js";
import type { PlatformBridge } from "../bridge.js";
import { createFixtureBridge } from "../bridge.fixture.js";
import { primarySelectionFor } from "./host.js";

/**
 * A fixture bridge reporting `platform`, the clipboard writes main was asked for, joined from
 * their pieces, and the content each written copy's pieces now join to.
 */
function bridgeOn(platform: PlatformBridge["app"]["platform"]): {
  readonly bridge: PlatformBridge;
  readonly writes: unknown[][];
  readonly heldContentOfEachWrite: () => (() => unknown)[];
} {
  const fixture = createFixtureBridge({ scenario: EMPTY_SESSION_SCENARIO });
  const writes: unknown[][] = [];
  const copyIds: string[] = [];
  vi.spyOn(fixture.bridge.native, "takeClipboardSnapshot").mockImplementation(async (clipboard) =>
    clipboard === "selection" ? { clipboard, digest: "held" } : expect.fail("the selection one"),
  );
  vi.spyOn(fixture.bridge.native, "copyToClipboardUnlessChanged").mockImplementation(
    async (copyId, since) => {
      copyIds.push(copyId);
      writes.push([fixture.clipboardPieces.contentOf(copyId), since]);
      return true;
    },
  );
  return {
    bridge: { ...fixture.bridge, app: { ...fixture.bridge.app, platform } },
    writes,
    heldContentOfEachWrite: () =>
      copyIds.map((copyId) => () => fixture.clipboardPieces.contentOf(copyId)),
  };
}

describe("the primary selection a settled selection takes", () => {
  it("puts the text on Linux's selection clipboard, its pieces let go once written", async () => {
    const { bridge, writes, heldContentOfEachWrite } = bridgeOn("linux");
    const text = "rename the reader\n".repeat(TEXT_PIECE_LENGTH / 8);

    await primarySelectionFor(bridge).takeSettledSelection(
      () => Promise.resolve(piecedTextOf(text)),
      TASKS_AT_ONCE,
    );

    expect(writes).toStrictEqual([[{ text }, { clipboard: "selection", digest: "held" }]]);
    const [heldContent] = heldContentOfEachWrite();
    expect(heldContent).toThrow("A clipboard piece names a copy that is not held.");
  });

  it.each(["darwin", "win32"] as const)("reads and writes nothing on %s", async (platform) => {
    const { bridge, writes } = bridgeOn(platform);
    const readText = vi.fn(() => Promise.resolve(piecedTextOf("rename the reader")));

    await primarySelectionFor(bridge).takeSettledSelection(readText, TASKS_AT_ONCE);

    expect([writes, readText.mock.calls]).toStrictEqual([[], []]);
  });
});
