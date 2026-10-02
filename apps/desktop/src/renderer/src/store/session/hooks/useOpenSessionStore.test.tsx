import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useOpenSessionStore } from "./useOpenSessionStore.js";
import { type SessionBaseStateReader } from "../open-session-entry.js";
import { SessionStoreRegistry } from "../session-store-registry.js";
import type { SessionStore } from "../session-store.js";
import { ManualClock } from "@renderer/lib/clock.js";

const readsNothing: SessionBaseStateReader = () => Promise.resolve(undefined);

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
    // A session that is not open is a real answer, not a reason to open one while rendering.
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
});
