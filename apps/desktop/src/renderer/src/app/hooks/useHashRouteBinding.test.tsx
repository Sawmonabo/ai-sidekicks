// What keeps the two-way binding from oscillating: it does not re-adopt its own write, even when
// the echo arrives after the person navigated on. The case drives the real hook against a real
// `WindowStore` and the real `window.location.hash`, since the subject is how the browser's
// `hashchange` interleaves with a navigation.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { SESSIONS_HASH } from "#test/helpers/mount-app.js";
import { WindowStore } from "#renderer/store/window/window-store.js";
import { useLocationHash } from "#renderer/routing/hooks/useLocationHash.js";
import { useHashRouteBinding } from "./useHashRouteBinding.js";

const SETTINGS_HASH = "#/settings";
const SESSION_HASH = "#/session/session-alpha";

function BoundFrame(props: { readonly frameStore: WindowStore }): React.JSX.Element {
  const hash = useLocationHash(window);
  useHashRouteBinding(props.frameStore, hash, window);
  return <div data-testid="bound" />;
}

/**
 * Let anything the browser queued land.
 *
 * A macrotask rather than a microtask: happy-dom raises `hashchange` on a task of its own, so
 * a promise flush (`tests/helpers/settle.ts`) returns before the echo the binding waits for.
 */
async function settleQueuedBrowserTask(): Promise<void> {
  await act(async () => {
    await crossMacrotaskBoundary();
  });
}

afterEach(async () => {
  cleanup();
  // Resetting the address queues a `hashchange`; landing it here leaves no listener to hear it.
  window.location.hash = SESSIONS_HASH;
  await crossMacrotaskBoundary();
});

describe("useHashRouteBinding", () => {
  it("does not let the echo of its own write undo a later navigation", async () => {
    window.location.hash = SESSION_HASH;
    const frameStore = new WindowStore({
      initialRoute: { kind: "session", sessionId: "session-alpha" },
    });
    await act(async () => {
      render(<BoundFrame frameStore={frameStore} />);
      await crossMacrotaskBoundary();
    });

    // The binding writes `#/settings`; the browser has not delivered that `hashchange` yet.
    await act(async () => {
      frameStore.navigate({ kind: "settings", page: undefined });
    });
    expect(window.location.hash).toBe(SETTINGS_HASH);

    // Navigate again while the echo is in flight: it names Settings and must not win.
    await act(async () => {
      frameStore.navigate({ kind: "session", sessionId: "session-alpha" });
    });
    await settleQueuedBrowserTask();

    expect(frameStore.getState().route).toEqual({ kind: "session", sessionId: "session-alpha" });
    expect(window.location.hash).toBe(SESSION_HASH);
  });
});
