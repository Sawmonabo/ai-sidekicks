import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useSessionStore } from "./useOpenSessionStore.js";
import { useSessionInitialized } from "./useSessionInitialized.js";
import {
  openingPageLimit,
  offScreenRowLimit,
  readsNothing,
} from "#test/helpers/session/store/fixtures.js";
import { SessionStoreRegistry } from "../registry.js";
import type { SessionStore } from "../store.js";
import { ManualClock } from "#renderer/lib/clock.js";

function StoreHeader(props: { readonly store: SessionStore }): React.JSX.Element {
  const initialized = useSessionInitialized(props.store);
  const cursor = useSessionStore(props.store, (state) => state.cursor);
  return (
    <span data-testid="header">{`${initialized ? "ready" : "loading"}:${String(cursor)}`}</span>
  );
}

describe("useSessionInitialized / useSessionStore — the store's own facts", () => {
  it("reports loading before a read lands and ready after it", () => {
    const clock = new ManualClock(0);
    const registry = new SessionStoreRegistry({
      read: readsNothing,
      clock,
      openingPageLimit,
      offScreenRowLimit,
    });
    const store = registry.open("session-1");

    const view = render(<StoreHeader store={store} />);
    expect(view.getByTestId("header").textContent).toBe("loading:-1");

    act(() => {
      store.initialize({ cursor: 4, entities: [] });
    });

    expect(view.getByTestId("header").textContent).toBe("ready:4");
    view.unmount();
    registry.disposeAll();
  });
});
