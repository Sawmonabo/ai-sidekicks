// The registry is the window's, and a window that changes transports gets a new one.
//
// TWO LIFETIMES PULLING OPPOSITE WAYS, WHICH IS WHY THIS SEAM IS A BINDING AND NOT A
// SURFACE. A hand-off holds subscriptions opened over one bridge's auxiliary-window
// plane, so a scenario switch that replaces the bridge has to retire every one of them
// — a registry that survived would go on draining a signal from a resolution nothing
// above it reads. A NAVIGATION must do the opposite and disturb nothing, because the
// shell keeps the windows open whatever this window is looking at; that half is
// `aux-handoff-registry.test.ts`' and `Workspace.auxiliary.test.tsx`'.
//
// The registry is read through the binding's own hook rather than reached for
// directly, because that hook is the only way any surface gets one — a case that
// constructed one here would be asserting against a registry no window holds.

import { render } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { FLAGSHIP_SCENARIO } from "../../bridge/scenario/flagship/flagship.js";
import { type FrameBindingContext } from "../../seats/index.js";
import { FrameStore, SessionStoreRegistry } from "../../store/index.js";
import { DetachedPaneBinding, useAuxiliaryHandoffRegistry } from "./DetachedPaneBinding.js";
import { type AuxiliaryHandoffRegistry } from "./aux-handoff-registry.js";
import { servingPort } from "./aux-handoff.test-support.js";

/**
 * Every distinct registry the subtree was given, in the order it saw them.
 *
 * A class rather than a bare array, so the de-duplication is written once: React
 * re-runs an effect whenever its dependencies move and a case that pushed on every run
 * would be counting renders rather than registries.
 */
class ObservedRegistries {
  readonly #inOrder: AuxiliaryHandoffRegistry[] = [];

  public record(registry: AuxiliaryHandoffRegistry): void {
    if (this.#inOrder.at(-1) !== registry) {
      this.#inOrder.push(registry);
    }
  }

  public get inOrder(): readonly AuxiliaryHandoffRegistry[] {
    return this.#inOrder;
  }

  /** The one a case asserts on, refusing rather than answering `undefined`. */
  public at(position: number): AuxiliaryHandoffRegistry {
    const held = this.#inOrder[position];
    if (held === undefined) {
      throw new Error(`no registry was provided at position ${String(position)}`);
    }
    return held;
  }
}

/** A subtree that does nothing but say which registry it was handed. */
function RegistryProbe(props: { readonly observed: ObservedRegistries }): React.JSX.Element {
  const registry = useAuxiliaryHandoffRegistry();
  const { observed } = props;
  useEffect(() => {
    observed.record(registry);
  }, [observed, registry]);
  return <p>bound</p>;
}

/**
 * One window's binding context, over a plane that serves the window operations.
 *
 * The plane is stated rather than taken off the fixture: a browser-mode run has no
 * shell behind it, so the fixture's own arm answers `shell-absent`.
 */
function windowContext(): FrameBindingContext {
  return {
    bridge: {
      ...createFixtureBridge({ scenario: FLAGSHIP_SCENARIO }),
      auxiliaryWindows: servingPort(),
    } satisfies ConsoleBridge,
    frameStore: new FrameStore(),
    // The REAL registry rather than a stub, on `SettingsSurface.test-support.tsx`'
    // rule: this binding reads neither member, and a hand-built pair would let a case
    // assert against a context shape no frame ever hands over.
    sessionStoreRegistry: new SessionStoreRegistry({ read: () => Promise.resolve(undefined) }),
  };
}

describe("DetachedPaneBinding — the registry's subject is the bridge", () => {
  it("provides one registry to everything below it", () => {
    const observed = new ObservedRegistries();

    render(
      <DetachedPaneBinding context={windowContext()}>
        <RegistryProbe observed={observed} />
      </DetachedPaneBinding>,
    );

    expect(observed.inOrder).toHaveLength(1);
    expect(observed.at(0).isDisposed).toBe(false);
  });

  it("retires the registry when the window's bridge is replaced", () => {
    const observed = new ObservedRegistries();
    const { rerender } = render(
      <DetachedPaneBinding context={windowContext()}>
        <RegistryProbe observed={observed} />
      </DetachedPaneBinding>,
    );

    rerender(
      <DetachedPaneBinding context={windowContext()}>
        <RegistryProbe observed={observed} />
      </DetachedPaneBinding>,
    );

    expect(observed.inOrder).toHaveLength(2);
    // Disposed rather than merely dropped: every hand-off it held opened its window
    // signals over the retired plane, and a registry let go of without being told
    // would leave those subscriptions draining into nothing.
    expect(observed.at(0).isDisposed).toBe(true);
    expect(observed.at(1).isDisposed).toBe(false);
  });

  it("negative control: a rerender under the same bridge keeps the registry", () => {
    // Without this the case above would pass over a binding that minted a registry on
    // every render — which is not a subject-scoped resource but a leak, and would take
    // the detached set down on a pass nothing moved on.
    const observed = new ObservedRegistries();
    const context = windowContext();
    const { rerender } = render(
      <DetachedPaneBinding context={context}>
        <RegistryProbe observed={observed} />
      </DetachedPaneBinding>,
    );

    rerender(
      <DetachedPaneBinding context={context}>
        <RegistryProbe observed={observed} />
      </DetachedPaneBinding>,
    );

    expect(observed.inOrder).toHaveLength(1);
    expect(observed.at(0).isDisposed).toBe(false);
  });
});
