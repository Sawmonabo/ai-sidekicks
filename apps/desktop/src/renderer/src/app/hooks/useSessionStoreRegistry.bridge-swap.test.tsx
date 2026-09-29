// The window's plumbing belongs to the bridge it was built from.
//
// `DesktopBridgeProvider` replaces its resolution when the `bridge` prop changes —
// a reconnect, or the fixture's scenario switch — and every window under it renders
// against the new one from the next commit on. What this file drives is the half
// below that: the registry and binder were built FROM a bridge, and a hook that did
// not re-mint them in that same render left a committed frame pairing the NEW bridge
// with the OLD plumbing — a window reading sessions through a transport nothing was
// serving, and a binder subscribed to it. Nothing in a snapshot shows that; the
// surface renders a live session that simply never changes again.
//
// SO THE CLAIM IS ABOUT EVERY COMMITTED FRAME, not about where the window settles.
// The shape this replaced settled correctly by accident: its disposal effect listed
// `bridge` among dependencies its body never read, so a replacement tore the LIVE
// plumbing down and rebuilt it only because `disposeAll` happens to set `isDisposed`
// before the same effect's body reads it — one frame later, with the mismatched frame
// already committed in between. An assertion about the end state passes on both, so
// every case here records what each RENDER was handed and asserts over all of them.
//
// The witness is which bridge each render was handed alongside which registry: two
// distinct fixture bridges, and the pairing read in the render body, with no scenario
// data, no event, and no timing in the assertion.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixture } from "@test/helpers/fixture-bridge.js";
import { DesktopBridgeProvider } from "@renderer/services/platform/PlatformBridgeProvider.js";
import { useConsoleBridge } from "@renderer/services/platform/hooks/usePlatformBridge.js";
import { type ConsoleBridge } from "@renderer/services/platform/platform-bridge.js";
import { ConsoleEntityProjectorRegistry } from "@renderer/registries/entity-projectors/entity-projector-registry.js";
import { type SessionSnapshotReader } from "@renderer/store/session/open-session-entry.js";
import { type SessionStoreRegistry } from "@renderer/store/session/session-store-registry.js";
import { useSessionStoreRegistry } from "./useSessionStoreRegistry.js";

const readNothing: SessionSnapshotReader = () => Promise.resolve(undefined);

/** What one committed render was handed, read in the render body rather than after. */
interface Observation {
  readonly bridge: ConsoleBridge;
  readonly registry: SessionStoreRegistry;
}

interface RegistryProbeProps {
  readonly projectorRegistry: ConsoleEntityProjectorRegistry;
  readonly onObserve: (observation: Observation) => void;
}

/** A component that owns a window's plumbing and reports what it was handed. */
function RegistryProbe(props: RegistryProbeProps): null {
  const bridge = useConsoleBridge();
  const registry = useSessionStoreRegistry(props.projectorRegistry, readNothing);
  props.onObserve({ bridge, registry });
  return null;
}

interface SwapHostProps extends RegistryProbeProps {
  readonly bridge: ConsoleBridge;
}

function SwapHost(props: SwapHostProps): React.JSX.Element {
  return (
    <DesktopBridgeProvider bridge={props.bridge}>
      <RegistryProbe projectorRegistry={props.projectorRegistry} onObserve={props.onObserve} />
    </DesktopBridgeProvider>
  );
}

interface SwapHarness {
  /** Every committed render, in order. */
  readonly observed: readonly Observation[];
  /** Every distinct registry that answered a render, in the order it appeared. */
  readonly registries: () => readonly SessionStoreRegistry[];
  /**
   * Re-render under a bridge, and optionally under a different projector board.
   *
   * The board is a parameter rather than a second harness because the claim it
   * carries is about this same hook: the board is NOT the plumbing's subject, so
   * replacing it must leave a live registry alone.
   */
  readonly renderAgainst: (
    bridge: ConsoleBridge,
    projectorRegistry?: ConsoleEntityProjectorRegistry,
  ) => void;
  readonly unmount: () => void;
}

/**
 * Mount a window against one bridge and keep the handle that re-renders it under
 * another.
 *
 * The projector board is built ONCE and handed to every render, because the hook
 * keys its disposal effect on that identity too: a board rebuilt per render would
 * re-mint the plumbing for a reason this file is not about, and every case here
 * would pass without the bridge ever deciding anything. It is empty on purpose —
 * which fold a store opens with is `useSessionStoreRegistry.registry-wiring.test.tsx`'s
 * subject, and this one is about which bridge the plumbing was built from.
 */
function mountAgainst(bridge: ConsoleBridge): SwapHarness {
  const observed: Observation[] = [];
  const record = (observation: Observation): void => {
    observed.push(observation);
  };
  const firstBoard = new ConsoleEntityProjectorRegistry();
  const hostFor = (
    against: ConsoleBridge,
    board: ConsoleEntityProjectorRegistry,
  ): React.JSX.Element => (
    <SwapHost bridge={against} projectorRegistry={board} onObserve={record} />
  );
  const mounted = render(hostFor(bridge, firstBoard));
  return {
    observed,
    registries: (): readonly SessionStoreRegistry[] => [
      ...new Set(observed.map((observation) => observation.registry)),
    ],
    renderAgainst: (
      next: ConsoleBridge,
      board: ConsoleEntityProjectorRegistry = firstBoard,
    ): void => {
      mounted.rerender(hostFor(next, board));
    },
    unmount: (): void => {
      mounted.unmount();
    },
  };
}

describe("useSessionStoreRegistry — the plumbing follows the bridge", () => {
  it("never hands one registry to two different bridges", () => {
    // The same claim from the resource's side, and it holds without knowing what a
    // registry reads: a plumbing that outlived its bridge is one object two bridges
    // both rendered against.
    const harness = mountAgainst(createFixture().bridge);

    harness.renderAgainst(createFixture().bridge);

    const bridgesPerRegistry = new Map<SessionStoreRegistry, Set<ConsoleBridge>>();
    for (const observation of harness.observed) {
      const bridges = bridgesPerRegistry.get(observation.registry) ?? new Set<ConsoleBridge>();
      bridges.add(observation.bridge);
      bridgesPerRegistry.set(observation.registry, bridges);
    }
    const shared = [...bridgesPerRegistry.values()].filter((bridges) => bridges.size > 1);
    expect(shared).toStrictEqual([]);

    harness.unmount();
  });

  it("re-mints the plumbing under a new bridge and disposes the one it replaced", () => {
    const harness = mountAgainst(createFixture().bridge);
    const retired = harness.registries().at(-1);
    expect(retired).toBeDefined();
    if (retired === undefined) {
      return;
    }

    harness.renderAgainst(createFixture().bridge);

    const current = harness.registries().at(-1);
    expect(harness.registries()).toHaveLength(2);
    expect(current).not.toBe(retired);
    // The old one is not merely dropped. A registry owns apply queues and refresh
    // schedulers, so a hook that let go of it without disposing it would leave those
    // running against a bridge nobody is reading.
    expect(retired.isDisposed).toBe(true);
    expect(current?.isDisposed).toBe(false);

    harness.unmount();
  });

  it("answers a re-render under the same bridge with the same registry", () => {
    // The control on every case above: a hook that re-minted on each render would
    // satisfy them all and fail here, and one that never re-minted would do the
    // reverse.
    const bridge = createFixture().bridge;
    const harness = mountAgainst(bridge);

    harness.renderAgainst(bridge);
    harness.renderAgainst(bridge);

    expect(harness.observed.length).toBeGreaterThan(2);
    expect(harness.registries()).toHaveLength(1);
    expect(harness.registries()[0]?.isDisposed).toBe(false);

    harness.unmount();
  });

  it("re-mints again on the way back, rather than reviving the one it disposed", () => {
    // The comparison is against the bridge the plumbing is CURRENTLY held under, not
    // against the first one ever seen. A hook that remembered only its original
    // bridge would hand back the disposed registry here.
    const serving = createFixture().bridge;
    const harness = mountAgainst(serving);
    const first = harness.registries().at(-1);

    harness.renderAgainst(createFixture().bridge);
    harness.renderAgainst(serving);

    const registries = harness.registries();
    const third = registries.at(-1);
    expect(registries).toHaveLength(3);
    expect(third).not.toBe(first);
    expect(third?.isDisposed).toBe(false);
    expect(registries.slice(0, 2).every((registry) => registry.isDisposed)).toBe(true);

    harness.unmount();
  });

  it("leaves live plumbing alone when a dependency that is not its subject changes", () => {
    // The projector board is deliberately not the plumbing's subject: a registry
    // takes a SNAPSHOT of it at construction, so a board replaced later is not part
    // of what this resource is about. The shape this replaced disposed the LIVE
    // registry anyway — its one effect listed the board among dependencies its
    // teardown did not read — and then rebuilt it only because `disposeAll` happens
    // to set `isDisposed` before the body reads it. Between those two moments every
    // `useOpenSessionStore` consumer reads through a disposed registry.
    const bridge = createFixture().bridge;
    const harness = mountAgainst(bridge);
    const live = harness.registries().at(-1);
    expect(live).toBeDefined();

    harness.renderAgainst(bridge, new ConsoleEntityProjectorRegistry());

    expect(harness.registries()).toHaveLength(1);
    expect(harness.registries()[0]).toBe(live);
    expect(live?.isDisposed).toBe(false);

    // Negative control: the subject that IS the plumbing's still retires it, so the
    // claim above is about which dependency decided rather than about a hook that
    // stopped re-minting at all.
    harness.renderAgainst(createFixture().bridge);
    expect(harness.registries()).toHaveLength(2);
    expect(live?.isDisposed).toBe(true);

    harness.unmount();
  });

  it("disposes the registry it is holding when the window goes away", () => {
    const harness = mountAgainst(createFixture().bridge);
    harness.renderAgainst(createFixture().bridge);
    expect(harness.registries().at(-1)?.isDisposed).toBe(false);

    harness.unmount();

    expect(harness.registries().every((registry) => registry.isDisposed)).toBe(true);
  });
});
