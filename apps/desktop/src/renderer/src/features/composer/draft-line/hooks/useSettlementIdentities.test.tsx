// The mirrors name the visit on screen, and a render that never committed moves nothing. The
// case builds a discarded pass for real: a transition that re-addresses the composer and
// suspends renders every hook, then is thrown away with the previous tree still mounted.

import { act, render, screen } from "@testing-library/react";
import { Suspense, startTransition, useState } from "react";
import { describe, expect, it } from "vitest";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { WAITING_FOR_INPUT_SCENARIO } from "../../../../../../../fixtures/scenarios/waiting-for-input.js";
import { useSettlementIdentities, type SettlementIdentities } from "./useSettlementIdentities.js";

/** A promise that never settles, so a component reading it suspends for the test. */
const NEVER_SETTLES = new Promise<void>(() => undefined);

/** Suspends the moment it is asked to, and renders nothing when it is not. */
function SuspendsWhenAsked(props: { readonly suspend: boolean }): React.JSX.Element | null {
  if (props.suspend) {
    throw NEVER_SETTLES;
  }
  return null;
}

/**
 * The hook under a tree that can re-address and suspend in one transition. `readdress` is
 * handed back through a holder because it must fire outside React's render.
 */
function ComposerHost(props: {
  readonly bridge: PlatformBridge;
  readonly seen: { current: SettlementIdentities | undefined };
  readonly readdress: { current: (() => void) | undefined };
}): React.JSX.Element {
  const [draftKey, setDraftKey] = useState("session-1::agent-ada");
  const [suspend, setSuspend] = useState(false);
  props.seen.current = useSettlementIdentities(props.bridge, draftKey);
  props.readdress.current = () => {
    setDraftKey("session-1::agent-priya");
    setSuspend(true);
  };
  return (
    <Suspense fallback={<p>reading</p>}>
      <SuspendsWhenAsked suspend={suspend} />
      <p>composer</p>
    </Suspense>
  );
}

describe("the settlement mirrors move at the commit", () => {
  it("still calls the on-screen visit current after a discarded re-address", async () => {
    const seen: { current: SettlementIdentities | undefined } = { current: undefined };
    const readdress: { current: (() => void) | undefined } = { current: undefined };
    render(
      <ComposerHost
        bridge={createFixtureBridge({ scenario: WAITING_FOR_INPUT_SCENARIO }).bridge}
        seen={seen}
        readdress={readdress}
      />,
    );
    const issued = seen.current?.issue("send");

    await act(async () => {
      startTransition(() => {
        readdress.current?.();
      });
    });

    // The discarded pass ran this hook under the new draft key; written during that render,
    // the mirrors would name a visit nothing committed.
    expect(screen.queryByText("composer")).not.toBeNull();
    expect(issued).toBeDefined();
    expect(seen.current?.isCurrent(issued as NonNullable<typeof issued>)).toBe(true);
  });

  it("keeps the act on screen current after the register is narrowed to its address", () => {
    // Narrowing shares the layout effect that moves the mirrors, so the failure to catch is
    // dropping the just-committed address's key, which would discard its settlement. The bound
    // itself is asserted in `send-settlement.test.ts`.
    const seen: { current: SettlementIdentities | undefined } = { current: undefined };
    const readdress: { current: (() => void) | undefined } = { current: undefined };
    render(
      <ComposerHost
        bridge={createFixtureBridge({ scenario: WAITING_FOR_INPUT_SCENARIO }).bridge}
        seen={seen}
        readdress={readdress}
      />,
    );
    seen.current?.issue("send");

    act(() => {
      readdress.current?.();
    });
    const afterReaddress = seen.current?.issue("send");

    expect(afterReaddress).toBeDefined();
    expect(seen.current?.isCurrent(afterReaddress as NonNullable<typeof afterReaddress>)).toBe(
      true,
    );
  });

  it("negative control: a committed re-address retires the earlier visit's act", () => {
    // Without this, the case above would pass a hook that called every settlement current.
    const seen: { current: SettlementIdentities | undefined } = { current: undefined };
    const readdress: { current: (() => void) | undefined } = { current: undefined };
    render(
      <ComposerHost
        bridge={createFixtureBridge({ scenario: WAITING_FOR_INPUT_SCENARIO }).bridge}
        seen={seen}
        readdress={readdress}
      />,
    );
    const issued = seen.current?.issue("send");

    act(() => {
      readdress.current?.();
    });

    expect(issued).toBeDefined();
    expect(seen.current?.isCurrent(issued as NonNullable<typeof issued>)).toBe(false);
  });
});
