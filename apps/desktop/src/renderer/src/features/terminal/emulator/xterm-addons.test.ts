// The renderer selection as something a component can follow: the mode is published as a
// current-value-then-changes subscription, because a consumer that copied it and subscribed
// afterwards would hold a stale value. The fallback after a context loss needs the addon stood
// in, so it is `xterm-adapter.context-loss.test.ts`'s.

import { afterEach, describe, expect, it } from "vitest";

import {
  disposeLiveEmulators,
  mountedAdapter,
  unattachedAdapter,
} from "./xterm-adapter.test-support.js";

afterEach(disposeLiveEmulators);

describe("the renderer mode, as something a component can follow", () => {
  it("delivers the current mode on subscribe, before an emulator exists", () => {
    // A fresh adapter reports the fallback mode, since nothing has been selected yet.
    const adapter = unattachedAdapter({ terminalId: "unattached" });
    const observed: string[] = [];
    adapter.subscribeToRendererMode((mode) => observed.push(mode));
    expect(observed).toStrictEqual(["dom"]);
  });

  it("says nothing further on a host that never had a context to lose", () => {
    // This environment has no WebGL2, so the selection settles on the constructed mode;
    // announcing that would report a fallback that never happened.
    const { adapter } = mountedAdapter({ terminalId: "no-context" });
    const observed: string[] = [];
    adapter.subscribeToRendererMode((mode) => observed.push(mode));
    adapter.dispose();
    expect(observed).toStrictEqual(["dom"]);
  });
});
