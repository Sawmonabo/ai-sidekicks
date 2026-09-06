// The page ledger allocates by CONTEXT, and this is the only environment that can say
// so.
//
// A terminal id is a session's id, and two panes on one session each build their own
// addon and their own context — which the fixture pane harness mounts on purpose. On a
// host with no WebGL2 neither pane ever holds one, so the arithmetic below is
// unobservable in `renderer-pool.test.ts` beside this file, which drives the ledger
// directly and never activates a renderer. Here one does, and the two panes really are
// drawing on two contexts.
//
// See `webgl-fallback.test-support.ts` for what is stood in and why this is a file of
// its own rather than a block in that neighbour.

import { afterEach, describe, expect, it, vi } from "vitest";

import { TerminalRendererPool } from "./renderer-pool.js";
import { XtermTerminalAdapter } from "./xterm-adapter.js";
import { attachedHost, disposeLiveEmulators, trackAdapter } from "./xterm-adapter.test-support.js";
import { FakeWebglRenderer, resetWebglFallback } from "./webgl-fallback.test-support.js";

vi.mock("@xterm/addon-webgl", async () => ({
  WebglAddon: (await import("./webgl-fallback.test-support.js")).FakeWebglRenderer,
}));

afterEach(() => {
  disposeLiveEmulators();
  resetWebglFallback();
});

// The ledger allocates by CONTEXT, and this is the only environment that can say so.
//
// A terminal id is a session's id, and two panes on one session each build their own
// addon and their own context — which the fixture pane harness mounts on purpose. On
// a host with no WebGL2 neither pane ever holds one, so the arithmetic below is
// unobservable in the two files that drive the real addon; here a renderer activates,
// and the two panes really are drawing on two contexts.
describe("two panes on one session", () => {
  it("spend two contexts, and one pane's teardown leaves the other drawing", () => {
    const pool = new TerminalRendererPool();
    const sessionTerminalId = "shared-session";
    const firstPane = trackAdapter(
      new XtermTerminalAdapter({ terminalId: sessionTerminalId, pool }),
    );
    firstPane.attach(attachedHost());
    const secondPane = trackAdapter(
      new XtermTerminalAdapter({ terminalId: sessionTerminalId, pool }),
    );
    secondPane.attach(attachedHost());

    // Two renderers, two contexts, two of the page's allowance spent. The id-keyed
    // ledger reported one here while the page held two, which is how a burst of
    // duplicate panes walked past the cap into Chromium's own eviction.
    expect(FakeWebglRenderer.live).toHaveLength(2);
    expect(pool.createdContextCount).toBe(2);
    expect(pool.heldContextCountFor(sessionTerminalId)).toBe(2);

    firstPane.dispose();

    // A teardown RELEASES the lease it holds and does not reclaim it: the context
    // this pane made outlives its addon, so the page's allowance stays spent. And
    // it names its own lease, so the pane still on screen keeps its context —
    // under the id-keyed ledger this teardown deleted the one record both panes
    // shared and left the survivor drawing on a context nothing counted.
    expect(pool.heldContextCountFor(sessionTerminalId)).toBe(1);
    expect(pool.holds(sessionTerminalId)).toBe(true);
    expect(pool.createdContextCount).toBe(2);
    expect(secondPane.rendererMode).toBe("webgl");
  });

  it("negative control: the survivor's own teardown then gives up the last hold", () => {
    // Without it the case above would pass against a ledger that never released
    // anything at all, which would report a held context for the life of the page.
    const pool = new TerminalRendererPool();
    const onlyPane = trackAdapter(new XtermTerminalAdapter({ terminalId: "solo-session", pool }));
    onlyPane.attach(attachedHost());
    expect(pool.holds("solo-session")).toBe(true);

    onlyPane.dispose();

    expect(pool.holds("solo-session")).toBe(false);
    expect(pool.createdContextCount).toBe(1);
  });
});
