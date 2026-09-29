import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useOpenSessionStore } from "./useOpenSessionStore.js";
import { type SessionSnapshotReader } from "../open-session-entry.js";
import { SessionStoreRegistry } from "../session-store-registry.js";
import type { SessionStore } from "../session-store.js";
import { ManualClock } from "@renderer/lib/clock.js";

const readsNothing: SessionSnapshotReader = () => Promise.resolve(undefined);

describe("useOpenSessionStore — components resolve a store, never construct one", () => {
  it("follows the registry as a session opens and closes", () => {
    const clock = new ManualClock(0);
    const registry = new SessionStoreRegistry({ read: readsNothing, clock });
    const resolved: (SessionStore | undefined)[] = [];

    function StoreProbe(): React.JSX.Element {
      const store = useOpenSessionStore(registry, "session-1");
      resolved.push(store);
      return <span data-testid="probe">{store === undefined ? "none" : store.sessionId}</span>;
    }

    const view = render(<StoreProbe />);
    // A session that is not open is a real answer the surface renders, and NOT a
    // reason to open one from inside a render pass React may discard.
    expect(view.getByTestId("probe").textContent).toBe("none");
    expect(registry.openCount).toBe(0);

    let opened: SessionStore | undefined;
    act(() => {
      opened = registry.open("session-1");
    });
    expect(view.getByTestId("probe").textContent).toBe("session-1");
    expect(resolved.at(-1)).toBe(opened);

    act(() => {
      registry.close("session-1");
    });
    expect(view.getByTestId("probe").textContent).toBe("none");

    view.unmount();
    registry.disposeAll();
  });

  it("resolves nothing for a session id the caller does not have yet", () => {
    // The negative control for the case above: an undefined id must not resolve to
    // whichever session happens to be open.
    const registry = new SessionStoreRegistry({ read: readsNothing, clock: new ManualClock(0) });
    registry.open("session-1");

    function StoreProbe(): React.JSX.Element {
      const store = useOpenSessionStore(registry, undefined);
      return <span data-testid="probe">{store === undefined ? "none" : store.sessionId}</span>;
    }

    const view = render(<StoreProbe />);
    expect(view.getByTestId("probe").textContent).toBe("none");

    view.unmount();
    registry.disposeAll();
  });
});
