// The page ledger allocates by context, and only this environment can show it: two panes on one
// session each build their own addon and context (the fixture pane harness mounts that on
// purpose), but with no WebGL2 neither holds one in `renderer-pool.test.ts`. See
// `webgl-fallback.test-support.ts` for what is stood in.

import { afterEach, describe, expect, it, vi } from "vitest";

import { TerminalRendererPool } from "./renderer-pool.js";
import { XtermTerminalAdapter } from "./xterm-adapter.js";
import {
  attachedMountElement,
  disposeLiveEmulators,
  trackAdapter,
} from "./xterm-adapter.test-support.js";
import { FakeWebglRenderer, resetWebglFallback } from "./webgl-fallback.test-support.js";

vi.mock("@xterm/addon-webgl", async () => ({
  WebglAddon: (await import("./webgl-fallback.test-support.js")).FakeWebglRenderer,
}));

afterEach(() => {
  disposeLiveEmulators();
  resetWebglFallback();
});

describe("two panes on one session", () => {
  it("spend two contexts, and one pane's teardown leaves the other drawing", () => {
    const pool = new TerminalRendererPool();
    const sessionTerminalId = "shared-session";
    const firstPane = trackAdapter(
      new XtermTerminalAdapter({ terminalId: sessionTerminalId, pool }),
    );
    firstPane.attach(attachedMountElement());
    const secondPane = trackAdapter(
      new XtermTerminalAdapter({ terminalId: sessionTerminalId, pool }),
    );
    secondPane.attach(attachedMountElement());

    // Two renderers, two contexts, two of the allowance spent; the id-keyed ledger reported one
    // while the page held two.
    expect(FakeWebglRenderer.live).toHaveLength(2);
    expect(pool.createdContextCount).toBe(2);
    expect(pool.heldContextCountFor(sessionTerminalId)).toBe(2);

    firstPane.dispose();

    // A teardown releases its own lease and does not reclaim it (the context outlives its
    // addon), so the pane still on screen keeps its context.
    expect(pool.heldContextCountFor(sessionTerminalId)).toBe(1);
    expect(pool.holds(sessionTerminalId)).toBe(true);
    expect(pool.createdContextCount).toBe(2);
    expect(secondPane.rendererMode).toBe("webgl");
  });

  it("negative control: the survivor's own teardown then gives up the last hold", () => {
    // Without it the case above would pass against a ledger that never released anything.
    const pool = new TerminalRendererPool();
    const onlyPane = trackAdapter(new XtermTerminalAdapter({ terminalId: "solo-session", pool }));
    onlyPane.attach(attachedMountElement());
    expect(pool.holds("solo-session")).toBe(true);

    onlyPane.dispose();

    expect(pool.holds("solo-session")).toBe(false);
    expect(pool.createdContextCount).toBe(1);
  });
});
