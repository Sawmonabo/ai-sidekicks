// The renderer selection, as something a surface can follow.
//
// The addon suite owns which renderer an instance settles on, and publishes it as a
// current-value-then-changes subscription rather than a field. Read-then-subscribe
// is the bug that shape removes: a consumer that copied the mode and subscribed
// afterwards would hold a value from before its own subscription.
//
// The FALLBACK — a renderer that activates and then loses its context — is
// `xterm-adapter.context-loss.test.ts`'s, because reaching it needs the addon stood
// in, and a module-scoped mock here would put these two cases on a renderer this
// environment does not have.
//
// Against the real library, and cleaned up through the directory's one live-emulator
// registry — see `xterm-adapter.test-support.ts` for both reasons.

import { afterEach, describe, expect, it } from "vitest";

import {
  disposeLiveEmulators,
  mountedAdapter,
  unattachedAdapter,
} from "./xterm-adapter.test-support.js";

afterEach(disposeLiveEmulators);

describe("the renderer mode, as something a surface can follow", () => {
  it("delivers the current mode on subscribe, before an emulator exists", () => {
    // Read-then-subscribe is the bug this shape removes: a consumer that copied
    // the mode and subscribed afterwards would hold a value from before its own
    // subscription. The mode a fresh adapter reports is the fallback, because
    // nothing has been selected yet.
    const adapter = unattachedAdapter({ terminalId: "unattached" });
    const observed: string[] = [];
    adapter.subscribeToRendererMode((mode) => observed.push(mode));
    expect(observed).toStrictEqual(["dom"]);
  });

  it("says nothing further on a host that never had a context to lose", () => {
    // This environment has no WebGL2, so the selection settles on the mode the
    // instance was constructed with. Announcing that would report a fallback that
    // never happened — the change the emulator's own context loss makes is
    // `webgl-context-loss.test.tsx`'s subject.
    const { adapter } = mountedAdapter({ terminalId: "no-context" });
    const observed: string[] = [];
    adapter.subscribeToRendererMode((mode) => observed.push(mode));
    adapter.dispose();
    expect(observed).toStrictEqual(["dom"]);
  });
});
