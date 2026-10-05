// A pin binding whose durable store was replaced, and what may still reach the old one. The
// window closes and remakes its store when the bridge changes; a binding built in a `useState`
// initializer would stay on the closed one, silently. The binding is driven through a mounted
// view, because the property is a React lifetime and calling `acquire` by hand would only prove
// the holder.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MemoryPersistenceAdapter } from "@renderer/store/persistence/memory-persistence-adapter.js";
import type { UiStateStore } from "@renderer/store/persistence/ui-state-store.js";
import { openStoreOver } from "@renderer/store/persistence/ui-state-store.test-support.js";
import { PINNED_SESSIONS_KEY, type SessionPins } from "../rows/session-pins.js";
import { useSessionPins } from "./useSessionPins.js";
import { settle as settleReactWork } from "@test/helpers/settle.js";

/** Let a durable read or write settle. Both are promises the acts do not await. */
async function settle(): Promise<void> {
  await settleReactWork();
}

/** A probe that renders the pin map it is bound to and offers the one act. */
function PinProbe(props: { readonly store: UiStateStore }): React.JSX.Element {
  const pins = useSessionPins(props.store);
  return (
    <button
      type="button"
      onClick={() => {
        pins.setPinned("session-a", true);
      }}
    >
      {JSON.stringify(pins.pinned)}
    </button>
  );
}

/** What is on screen, as the map the probe rendered. */
function renderedPins(container: HTMLElement): SessionPins {
  return JSON.parse(container.textContent ?? "{}") as SessionPins;
}

describe("the pin binding when the window replaces its durable store", () => {
  it("rebinds to the replacement rather than leaking the old map into it", async () => {
    const view = render(<PinProbe store={openStoreOver(new MemoryPersistenceAdapter())} />);
    await settle();
    act(() => {
      view.container.querySelector("button")?.click();
    });
    await settle();
    expect(renderedPins(view.container)).toStrictEqual({ "session-a": "pinned" });

    // A fresh adapter, as a scenario swap arrives: the replacement never saw these writes.
    view.rerender(<PinProbe store={openStoreOver(new MemoryPersistenceAdapter())} />);
    await settle();

    // The previous map is gone.
    expect(renderedPins(view.container)).toStrictEqual({});
  });

  it("sends a write made after the replacement to the replacement", async () => {
    // The half nobody sees: the map on screen could be right while every write still landed
    // in the closed database.
    const replacementAdapter = new MemoryPersistenceAdapter();
    const view = render(<PinProbe store={openStoreOver(new MemoryPersistenceAdapter())} />);
    await settle();
    view.rerender(<PinProbe store={openStoreOver(replacementAdapter)} />);
    await settle();

    act(() => {
      view.container.querySelector("button")?.click();
    });
    await settle();

    expect(renderedPins(view.container)).toStrictEqual({ "session-a": "pinned" });
    // Read back through a fresh store over the replacement's adapter: this asserts what was
    // persisted, not what is on screen.
    const readBack = await openStoreOver(replacementAdapter).readGlobal(PINNED_SESSIONS_KEY);
    expect(readBack?.value).toStrictEqual({ "session-a": "pinned" });
  });

  it("hydrates the replacement from what that store already holds", async () => {
    const replacementAdapter = new MemoryPersistenceAdapter();
    const seeding = openStoreOver(replacementAdapter);
    await seeding.writeGlobal(PINNED_SESSIONS_KEY, "pin", { "session-b": "pinned" });

    const view = render(<PinProbe store={openStoreOver(new MemoryPersistenceAdapter())} />);
    await settle();
    view.rerender(<PinProbe store={openStoreOver(replacementAdapter)} />);
    await settle();

    expect(renderedPins(view.container)).toStrictEqual({ "session-b": "pinned" });
  });

  it("negative control: a re-render with the SAME store keeps the binding it had", async () => {
    // Without this, the cases above could pass over a hook that re-minted every render,
    // re-reading the record after each local act.
    const store = openStoreOver(new MemoryPersistenceAdapter());
    const view = render(<PinProbe store={store} />);
    await settle();
    act(() => {
      view.container.querySelector("button")?.click();
    });
    await settle();

    view.rerender(<PinProbe store={store} />);
    await settle();

    expect(renderedPins(view.container)).toStrictEqual({ "session-a": "pinned" });
  });
});
