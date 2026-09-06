// What keeps a two-way binding from oscillating.
//
// Every case here drives the REAL hook against a real `FrameStore` and the real
// `window.location.hash`. Nothing is stubbed: the whole subject is how the browser's
// own `hashchange` interleaves with a navigation, and a stand-in for the hash would
// be a stand-in for the thing under test.
//
// Three claims:
//   1. the binding adopts a hash it did not write;
//   2. it does NOT re-adopt the one it did, even when the echo arrives after the
//      person has navigated on — the case that used to flip the window between two
//      destinations until React aborted the render with a depth error;
//   3. a hash change that lands in the same commit as a navigation settles, rather
//      than each direction undoing the other.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { drainMicrotasks } from "../core/microtask-drain.test-support.js";
import { formatRoute } from "../routing/index.js";
import { FrameStore, useLocationHash } from "../store/index.js";
import { useHashRouteBinding } from "./hash-route-binding.js";

const SESSIONS_HASH = "#/sessions";
const SETTINGS_HASH = "#/settings";
const WORKSPACE_HASH = "#/session/session-alpha";

function BoundFrame(props: { readonly frameStore: FrameStore }): React.JSX.Element {
  const hash = useLocationHash();
  useHashRouteBinding(props.frameStore, hash);
  return <div data-testid="bound" />;
}

/** Mount the binding on the hash the window is currently at. */
async function bind(): Promise<FrameStore> {
  const frameStore = new FrameStore({ initialRoute: { kind: "sessions" } });
  await act(async () => {
    render(<BoundFrame frameStore={frameStore} />);
    await drainMicrotasks();
  });
  return frameStore;
}

/**
 * Let anything the browser queued land.
 *
 * A macrotask rather than a microtask: happy-dom raises `hashchange` on a task of
 * its own, so a promise flush returns before the echo the binding is waiting for.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await drainMicrotasks();
  });
}

afterEach(async () => {
  cleanup();
  // Resetting the address queues a `hashchange` of its own, and happy-dom delivers
  // every queued `hashchange` on ONE debounced timer. A reset still in flight when
  // the next case starts is batched with that case's own change and delivered
  // inside its flush — where the last case counts address changes and would count
  // this one. So the reset lands here, with no binding mounted and no listener
  // registered to hear it, before the next case begins.
  window.location.hash = SESSIONS_HASH;
  await drainMicrotasks();
});

describe("useHashRouteBinding", () => {
  it("adopts a hash it did not write", async () => {
    window.location.hash = SESSIONS_HASH;
    const frameStore = await bind();

    await act(async () => {
      window.location.hash = WORKSPACE_HASH;
    });
    await settle();

    expect(frameStore.getState().route).toEqual({ kind: "workspace", sessionId: "session-alpha" });
  });

  it("publishes the route it was navigated to", async () => {
    window.location.hash = SESSIONS_HASH;
    const frameStore = await bind();

    await act(async () => {
      frameStore.navigate({ kind: "settings", page: undefined });
    });
    await settle();

    expect(window.location.hash).toBe(SETTINGS_HASH);
    expect(frameStore.getState().route).toEqual({ kind: "settings", page: undefined });
  });

  it("does not let the echo of its own write undo a later navigation", async () => {
    window.location.hash = WORKSPACE_HASH;
    const frameStore = new FrameStore({
      initialRoute: { kind: "workspace", sessionId: "session-alpha" },
    });
    await act(async () => {
      render(<BoundFrame frameStore={frameStore} />);
      await drainMicrotasks();
    });

    // Leave the workspace. The binding writes `#/settings`; the browser has not
    // delivered that `hashchange` back yet.
    await act(async () => {
      frameStore.navigate({ kind: "settings", page: undefined });
    });
    expect(window.location.hash).toBe(SETTINGS_HASH);

    // Navigate again while the echo is still in flight. The echo names Settings and
    // the person is asking for the workspace; the echo is not news and must not win.
    await act(async () => {
      frameStore.navigate({ kind: "workspace", sessionId: "session-alpha" });
    });
    await settle();

    expect(frameStore.getState().route).toEqual({ kind: "workspace", sessionId: "session-alpha" });
    expect(window.location.hash).toBe(WORKSPACE_HASH);
  });

  it("publishes nothing it has to take back when a hash change and a navigation land in one commit", async () => {
    window.location.hash = SESSIONS_HASH;
    const frameStore = await bind();

    const addressChanges: string[] = [];
    const recordAddressChange = (): void => {
      addressChanges.push(window.location.hash);
    };
    window.addEventListener("hashchange", recordAddressChange);

    // Two updates, one flush: the address moves and the rail navigates before React
    // has re-rendered for either, so both directions run against one commit in which
    // the hash and the route disagree.
    await act(async () => {
      window.location.hash = SETTINGS_HASH;
      frameStore.navigate({ kind: "workspace", sessionId: "session-alpha" });
    });
    await settle();
    window.removeEventListener("hashchange", recordAddressChange);

    // The hash and the route agree, and the binding got there in ONE address change
    // — the one the test made. A writer publishing the route its render closed over
    // would have put the workspace in the address, heard the adopt had already moved
    // the store, and put Settings back: two more entries for the back button to walk
    // through, and an address that briefly named somewhere the window is not going.
    expect(window.location.hash).toBe(formatRoute(frameStore.getState().route));
    expect(addressChanges).toHaveLength(1);
  });
});
