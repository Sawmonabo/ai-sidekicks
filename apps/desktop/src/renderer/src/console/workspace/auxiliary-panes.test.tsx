// The hand-off is the bridge's, and a bridge that is replaced takes it with it.
//
// A scenario switch replaces the bridge the surface renders under. Before this the
// hand-off was held in a mount-lifetime cell seeded on the first render, so the
// surface kept a hand-off whose growth port belonged to the retired resolution —
// still holding the crashed-window subscription it had opened there, still draining
// a signal nothing above it read. The resource seam makes the bridge the subject, so
// the retired hand-off is closed and a fresh one is opened against the live port.

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../bridge/index.js";
import { FLAGSHIP_SCENARIO } from "../bridge/scenarios/flagship.js";
import { useAuxiliaryPanes } from "./auxiliary-panes.js";

/**
 * A stable sink, so the identity these cases read is the hand-off's and not the
 * caller's: the acts are memoised on the hand-off AND on this callback, and an arrow
 * minted per render would change on every pass whatever the seam did.
 */
const IGNORE_REFUSAL = (): void => undefined;

describe("useAuxiliaryPanes — the hand-off follows the bridge", () => {
  function renderUnder(
    bridge: ConsoleBridge,
  ): ReturnType<
    typeof renderHook<ReturnType<typeof useAuxiliaryPanes>, { readonly bridge: ConsoleBridge }>
  > {
    return renderHook(
      (props: { readonly bridge: ConsoleBridge }) =>
        useAuxiliaryPanes({
          bridge: props.bridge,
          sessionId: FLAGSHIP_SCENARIO.sessionId,
          onRefused: IGNORE_REFUSAL,
        }),
      { initialProps: { bridge } },
    );
  }

  it("opens a fresh hand-off when the bridge is replaced", () => {
    const first = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });
    const { result, rerender } = renderUnder(first);
    const detachUnderFirstBridge = result.current.openInWindow;

    rerender({ bridge: createFixtureBridge({ scenario: FLAGSHIP_SCENARIO }) });

    // The acts are bound to the hand-off, so a hand-off that survived the swap would
    // hand back the identical function — which is exactly the retired-resolution
    // defect, and is what the assertion below refuses.
    expect(result.current.openInWindow).not.toBe(detachUnderFirstBridge);
  });

  it("negative control: a rerender under the same bridge keeps the hand-off", () => {
    // Without this the case above would pass over a seam that rebuilt the hand-off on
    // every render, which is not a subject-scoped resource but a leak: each pass would
    // open a subscription and lose the one before it.
    const bridge = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });
    const { result, rerender } = renderUnder(bridge);
    const detachUnderBridge = result.current.openInWindow;

    rerender({ bridge });

    expect(result.current.openInWindow).toBe(detachUnderBridge);
  });
});
