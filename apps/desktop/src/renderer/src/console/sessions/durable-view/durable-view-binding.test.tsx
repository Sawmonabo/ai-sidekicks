// A durable binding whose store was replaced, and what may still reach the old one.
//
// The defect is silent from every direction. `frame/ui-state-lifecycle.ts` closes
// this window's store and mints a fresh one whenever the bridge changes, and a
// binding built by a `useState` initializer stays attached to the closed store for
// the rest of the mount — so the previous scenario's value stays on screen, every
// later write lands in a database nothing reads, and the replacement is never
// hydrated. None of the three raises anything.
//
// Both durable bindings on this destination are driven here rather than only the
// holder, because the property under test is a React LIFETIME: a case that called
// `acquire` by hand would prove the holder's arithmetic and nothing about what a
// mounted surface is subscribed to.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MemoryPersistenceAdapter } from "../../persistence/memory-adapter.js";
import type { UiStateStore } from "../../persistence/index.js";
import { openStoreOver } from "../sessions.test-support.js";
import { DurableViewBindingHolder, type DurableViewBinding } from "./durable-view-binding.js";
import { HIDDEN_INVITES_KEY, useHiddenInvites } from "../invitations/hidden-invites.js";
import { SESSION_PIN_TIERS_KEY, useSessionPins, type SessionPinMap } from "../rows/session-pins.js";
import { settle as settleReactWork } from "../../core/settle.test-support.js";

/** Let a durable read or write settle. Both are promises the acts do not await. */
async function settle(): Promise<void> {
  await settleReactWork();
}

/**
 * A binding that records what the holder did to it and holds nothing else.
 *
 * A stub COLLABORATOR of the holder rather than a stand-in for a pin store: the
 * cases below that drive real behaviour drive the real stores, and what this one
 * buys is a count of disposals, which no real store exposes and none should.
 */
class RecordingBinding implements DurableViewBinding {
  public hydrateCount = 0;
  public disposeCount = 0;

  public async hydrate(): Promise<void> {
    this.hydrateCount += 1;
    await Promise.resolve();
  }

  public dispose(): void {
    this.disposeCount += 1;
  }

  public subscribe(): () => void {
    return () => undefined;
  }
}

describe("the holder that keys a binding on its store", () => {
  it("hands the same binding back while the store is the same", () => {
    const adapter = new MemoryPersistenceAdapter();
    const store = openStoreOver(adapter);
    const holder = new DurableViewBindingHolder(() => new RecordingBinding());
    expect(holder.acquire(store)).toBe(holder.acquire(store));
  });

  it("disposes the binding a different store supersedes, exactly once", () => {
    const adapter = new MemoryPersistenceAdapter();
    const holder = new DurableViewBindingHolder(() => new RecordingBinding());
    const first = holder.acquire(openStoreOver(adapter));
    const replacement = openStoreOver(adapter);
    const second = holder.acquire(replacement);
    holder.acquire(replacement);

    expect(first.disposeCount).toBe(1);
    expect(second).not.toBe(first);
    expect(second.disposeCount).toBe(0);
  });

  it("negative control: a render-body lookup mints and disposes nothing", () => {
    // Without this, the disposal above would pass over a holder whose pure lookup
    // also acquired — which is what makes a discarded render dispose the binding
    // the committed tree is subscribed to.
    const adapter = new MemoryPersistenceAdapter();
    const store = openStoreOver(adapter);
    const holder = new DurableViewBindingHolder(() => new RecordingBinding());
    expect(holder.bindingIfCurrent(store)).toBeUndefined();
    const acquired = holder.acquire(store);
    expect(holder.bindingIfCurrent(openStoreOver(adapter))).toBeUndefined();
    expect(acquired.disposeCount).toBe(0);
  });
});

/** A probe that renders the pin map it is bound to and offers the one act. */
function PinProbe(props: { readonly store: UiStateStore }): React.JSX.Element {
  const pins = useSessionPins(props.store);
  return (
    <button
      type="button"
      onClick={() => {
        pins.setTier("session-a", "front");
      }}
    >
      {JSON.stringify(pins.tiers)}
    </button>
  );
}

/** What is on screen, as the map the probe rendered. */
function renderedTiers(container: HTMLElement): SessionPinMap {
  return JSON.parse(container.textContent ?? "{}") as SessionPinMap;
}

describe("the pin binding when the window replaces its durable store", () => {
  it("rebinds to the replacement rather than leaking the old map into it", async () => {
    const view = render(<PinProbe store={openStoreOver(new MemoryPersistenceAdapter())} />);
    await settle();
    act(() => {
      view.container.querySelector("button")?.click();
    });
    await settle();
    expect(renderedTiers(view.container)).toStrictEqual({ "session-a": "front" });

    // A fresh adapter, the way a scenario swap arrives: the replacement store has
    // never seen this window's writes.
    view.rerender(<PinProbe store={openStoreOver(new MemoryPersistenceAdapter())} />);
    await settle();

    // The previous scenario's map is gone rather than leaking into the new one.
    expect(renderedTiers(view.container)).toStrictEqual({});
  });

  it("sends a write made after the replacement to the replacement", async () => {
    // The half of the defect nobody sees: the map on screen could be right and every
    // write still land in the closed database.
    const replacementAdapter = new MemoryPersistenceAdapter();
    const view = render(<PinProbe store={openStoreOver(new MemoryPersistenceAdapter())} />);
    await settle();
    view.rerender(<PinProbe store={openStoreOver(replacementAdapter)} />);
    await settle();

    act(() => {
      view.container.querySelector("button")?.click();
    });
    await settle();

    expect(renderedTiers(view.container)).toStrictEqual({ "session-a": "front" });
    // Read back through a fresh store over the replacement's own adapter, so the
    // assertion is about what was persisted rather than about what is on screen.
    const readBack = await openStoreOver(replacementAdapter).readGlobal(SESSION_PIN_TIERS_KEY);
    expect(readBack?.value).toStrictEqual({ "session-a": "front" });
  });

  it("hydrates the replacement from what that store already holds", async () => {
    const replacementAdapter = new MemoryPersistenceAdapter();
    const seeding = openStoreOver(replacementAdapter);
    await seeding.writeGlobal(SESSION_PIN_TIERS_KEY, "pin", { "session-b": "front" });

    const view = render(<PinProbe store={openStoreOver(new MemoryPersistenceAdapter())} />);
    await settle();
    view.rerender(<PinProbe store={openStoreOver(replacementAdapter)} />);
    await settle();

    expect(renderedTiers(view.container)).toStrictEqual({ "session-b": "front" });
  });

  it("negative control: a re-render with the SAME store keeps the binding it had", async () => {
    // Without this, every case above would pass over a hook that re-minted on every
    // render — which would re-read the record after each local act and put a pin
    // back the way a person had just changed it.
    const store = openStoreOver(new MemoryPersistenceAdapter());
    const view = render(<PinProbe store={store} />);
    await settle();
    act(() => {
      view.container.querySelector("button")?.click();
    });
    await settle();

    view.rerender(<PinProbe store={store} />);
    await settle();

    expect(renderedTiers(view.container)).toStrictEqual({ "session-a": "front" });
  });
});

/** A probe over the other binding, so the same lifetime is proved for both. */
function HiddenInviteProbe(props: { readonly store: UiStateStore }): React.JSX.Element {
  const hidden = useHiddenInvites(props.store);
  return (
    <button
      type="button"
      onClick={() => {
        hidden.hide("invite-1");
      }}
    >
      {JSON.stringify(hidden.hiddenInviteIds)}
    </button>
  );
}

describe("the hide-set binding when the window replaces its durable store", () => {
  it("rebinds to the replacement rather than leaking the set into it", async () => {
    const view = render(
      <HiddenInviteProbe store={openStoreOver(new MemoryPersistenceAdapter())} />,
    );
    await settle();
    act(() => {
      view.container.querySelector("button")?.click();
    });
    await settle();
    expect(view.container.textContent).toBe(JSON.stringify(["invite-1"]));

    view.rerender(<HiddenInviteProbe store={openStoreOver(new MemoryPersistenceAdapter())} />);
    await settle();

    expect(view.container.textContent).toBe(JSON.stringify([]));
  });

  it("sends a hide made after the replacement to the replacement", async () => {
    const replacementAdapter = new MemoryPersistenceAdapter();
    const view = render(
      <HiddenInviteProbe store={openStoreOver(new MemoryPersistenceAdapter())} />,
    );
    await settle();
    view.rerender(<HiddenInviteProbe store={openStoreOver(replacementAdapter)} />);
    await settle();

    act(() => {
      view.container.querySelector("button")?.click();
    });
    await settle();

    const readBack = await openStoreOver(replacementAdapter).readGlobal(HIDDEN_INVITES_KEY);
    expect(readBack?.value).toStrictEqual(["invite-1"]);
  });
});
