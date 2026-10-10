// A selection settled in the conversation reaches the system's primary selection on Linux, the
// one system that keeps one, and writes nothing elsewhere.

import { describe, expect, it, vi } from "vitest";

import { EMPTY_SESSION_SCENARIO } from "#fixtures/scenarios/empty-session.js";
import type { PlatformBridge } from "../bridge.js";
import { createFixtureBridge } from "../bridge.fixture.js";
import { primarySelectionFor } from "./host.js";

/** A fixture bridge reporting `platform`, and the clipboard writes main was asked for. */
function bridgeOn(platform: PlatformBridge["app"]["platform"]): {
  readonly bridge: PlatformBridge;
  readonly writes: unknown[][];
} {
  const fixture = createFixtureBridge({ scenario: EMPTY_SESSION_SCENARIO });
  const writes: unknown[][] = [];
  vi.spyOn(fixture.bridge.native, "copyToClipboard").mockImplementation(async (...request) => {
    writes.push(request);
  });
  return { bridge: { ...fixture.bridge, app: { ...fixture.bridge.app, platform } }, writes };
}

describe("the primary selection a settled selection takes", () => {
  it("puts the text on Linux's selection clipboard", async () => {
    const { bridge, writes } = bridgeOn("linux");

    await primarySelectionFor(bridge).takeSettledSelection(() =>
      Promise.resolve("rename the reader"),
    );

    expect(writes).toStrictEqual([[{ text: "rename the reader" }, "selection"]]);
  });

  it.each(["darwin", "win32"] as const)("reads and writes nothing on %s", async (platform) => {
    const { bridge, writes } = bridgeOn(platform);
    const readText = vi.fn(() => Promise.resolve("rename the reader"));

    await primarySelectionFor(bridge).takeSettledSelection(readText);

    expect([writes, readText.mock.calls]).toStrictEqual([[], []]);
  });
});
