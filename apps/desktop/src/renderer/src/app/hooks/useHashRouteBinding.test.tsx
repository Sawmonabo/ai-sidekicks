// What keeps a two-way binding from oscillating. Every case drives the real hook against a real
// `WindowStore` and the real `window.location.hash`, since the subject is how the browser's
// `hashchange` interleaves with a navigation. The binding adopts a hash it did not write, does
// not re-adopt its own write even when the echo arrives after the person navigated on, and
// settles when a hash change lands in the same commit as a navigation.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { formatRoute } from "@renderer/routing/routes.js";
import { WindowStore } from "@renderer/store/window/window-store.js";
import { useLocationHash } from "@renderer/routing/hooks/useLocationHash.js";
import { useHashRouteBinding } from "./useHashRouteBinding.js";

const SESSIONS_HASH = "#/sessions";
const SETTINGS_HASH = "#/settings";
const SESSION_HASH = "#/session/session-alpha";

function BoundFrame(props: { readonly frameStore: WindowStore }): React.JSX.Element {
  const hash = useLocationHash();
  useHashRouteBinding(props.frameStore, hash);
  return <div data-testid="bound" />;
}

/** Mount the binding on the hash the window is currently at. */
async function bind(): Promise<WindowStore> {
  const frameStore = new WindowStore({ initialRoute: { kind: "sessions" } });
  await act(async () => {
    render(<BoundFrame frameStore={frameStore} />);
    await crossMacrotaskBoundary();
  });
  return frameStore;
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
  // Resetting the address queues a `hashchange`, and happy-dom delivers queued ones on one
  // debounced timer. A reset still in flight would be batched into the next case's flush, where
  // the last case counts address changes; landing it here leaves no listener to hear it.
  window.location.hash = SESSIONS_HASH;
  await crossMacrotaskBoundary();
});

describe("useHashRouteBinding", () => {
  it("adopts a hash it did not write", async () => {
    window.location.hash = SESSIONS_HASH;
    const frameStore = await bind();

    await act(async () => {
      window.location.hash = SESSION_HASH;
    });
    await settleQueuedBrowserTask();

    expect(frameStore.getState().route).toEqual({ kind: "session", sessionId: "session-alpha" });
  });

  it("publishes the route it was navigated to", async () => {
    window.location.hash = SESSIONS_HASH;
    const frameStore = await bind();

    await act(async () => {
      frameStore.navigate({ kind: "settings", page: undefined });
    });
    await settleQueuedBrowserTask();

    expect(window.location.hash).toBe(SETTINGS_HASH);
    expect(frameStore.getState().route).toEqual({ kind: "settings", page: undefined });
  });

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

  it("publishes nothing it has to take back when a hash change and a navigation land in one commit", async () => {
    window.location.hash = SESSIONS_HASH;
    const frameStore = await bind();

    const addressChanges: string[] = [];
    const recordAddressChange = (): void => {
      addressChanges.push(window.location.hash);
    };
    window.addEventListener("hashchange", recordAddressChange);

    // Two updates, one flush: both directions run against one commit in which the hash and the
    // route disagree.
    await act(async () => {
      window.location.hash = SETTINGS_HASH;
      frameStore.navigate({ kind: "session", sessionId: "session-alpha" });
    });
    await settleQueuedBrowserTask();
    window.removeEventListener("hashchange", recordAddressChange);

    // One address change, the test's own. A writer publishing the route its render closed over
    // would add two history entries and briefly show a destination the window is not going to.
    expect(window.location.hash).toBe(formatRoute(frameStore.getState().route));
    expect(addressChanges).toHaveLength(1);
  });
});
