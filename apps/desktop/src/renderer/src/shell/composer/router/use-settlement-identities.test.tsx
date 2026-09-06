// The mirrors name the visit ON SCREEN, and a render that never became one moves
// nothing.
//
// The claim is about a pass React THROWS AWAY, so the case builds one for real rather
// than describing it: a transition that re-addresses the composer and suspends is
// rendered, runs every hook in the tree, and is then discarded with the previous tree
// still mounted. Nothing in this package reaches that state today — the case is what
// keeps this correct for the first concurrent feature that does.

import { act, render, screen } from "@testing-library/react";
import { Suspense, startTransition, useState } from "react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../../console/bridge/index.js";
import { COMPOSER_SCENARIO } from "../../../console/bridge/scenarios/composer.js";
import { useSettlementIdentities, type SettlementIdentities } from "./use-settlement-identities.js";

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
 * The hook under a tree that can re-address and suspend in one transition.
 *
 * `readdress` is handed back through a mutable holder rather than a callback prop
 * because the case has to fire it from OUTSIDE React's render, which is the only way
 * a transition is a transition.
 */
function ComposerHost(props: {
  readonly bridge: ConsoleBridge;
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
        bridge={createFixtureBridge({ scenario: COMPOSER_SCENARIO })}
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

    // The discarded pass ran this hook under the new draft key. Written during that
    // render, the mirrors would name a visit nothing committed, and the act a person
    // is still looking at would settle into nothing.
    expect(screen.queryByText("composer")).not.toBeNull();
    expect(issued).toBeDefined();
    expect(seen.current?.isCurrent(issued as NonNullable<typeof issued>)).toBe(true);
  });

  it("keeps the act on screen current after the register is narrowed to its address", () => {
    // The narrowing runs in the same layout effect that moves the mirrors, so the one
    // way it can go wrong is by dropping the key for the address it just committed —
    // which would make the composer's own newest act read as superseded and silently
    // discard its settlement. The bound itself is asserted over literals in
    // `send-settlement.test.ts`; this is the wiring, driven through a real re-address.
    const seen: { current: SettlementIdentities | undefined } = { current: undefined };
    const readdress: { current: (() => void) | undefined } = { current: undefined };
    render(
      <ComposerHost
        bridge={createFixtureBridge({ scenario: COMPOSER_SCENARIO })}
        seen={seen}
        readdress={readdress}
      />,
    );
    seen.current?.issue("send");

    act(() => {
      readdress.current?.();
    });
    const afterReaddress = seen.current?.issue("send");
    const stopAfterReaddress = seen.current?.issue("stop");

    expect(afterReaddress).toBeDefined();
    expect(stopAfterReaddress).toBeDefined();
    // The send was superseded by the Stop only in the sense that both are current:
    // they are different operations, so each holds its own entry at this address.
    expect(seen.current?.isCurrent(afterReaddress as NonNullable<typeof afterReaddress>)).toBe(
      true,
    );
    expect(
      seen.current?.isCurrent(stopAfterReaddress as NonNullable<typeof stopAfterReaddress>),
    ).toBe(true);
  });

  it("negative control: a committed re-address retires the earlier visit's act", () => {
    // Without this the case above would pass over a hook that called every settlement
    // current, which is the defect the identity exists to prevent.
    const seen: { current: SettlementIdentities | undefined } = { current: undefined };
    const readdress: { current: (() => void) | undefined } = { current: undefined };
    render(
      <ComposerHost
        bridge={createFixtureBridge({ scenario: COMPOSER_SCENARIO })}
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
