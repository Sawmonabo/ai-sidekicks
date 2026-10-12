// A kept sizes record read back: what an older or damaged record keeps and what it sets aside.

import { afterEach, describe, expect, it, vi } from "vitest";

import { windowDiagnosticCapture } from "#renderer/lib/diagnostic-capture/capture.js";
import { openStore } from "#renderer/store/persistence/ui-state-store.test-support.js";
import { KeptPaneSizes } from "./kept-sizes.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reading the kept pane sizes", () => {
  it("keeps every size it can draw beside one it cannot, and records the one set aside", async () => {
    const recorded = vi.spyOn(windowDiagnosticCapture, "record");
    const store = openStore();
    await store.writeGlobal("pane-sizes", "layout", {
      diff: { widthPx: 520 },
      browser: { widthPx: 0 },
      terminal: { widthPx: 600, stackedHeightPx: 240 },
    });

    const kept = new KeptPaneSizes(store);
    await kept.hydrate();

    expect(kept.sizes).toStrictEqual({
      widthsPx: { diff: 520, terminal: 600 },
      terminalHeightPx: 240,
    });
    expect(recorded.mock.calls.map(([record]) => record.detail)).toStrictEqual([
      "A kept pane size this build cannot draw was set aside at browser.widthPx",
    ]);
  });
});
