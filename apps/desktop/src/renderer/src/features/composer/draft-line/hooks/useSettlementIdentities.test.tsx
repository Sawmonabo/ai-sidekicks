// The mirrors name the visit on screen, and a render that never committed moves nothing. The
// case builds a discarded pass for real: a transition that re-addresses the composer and
// suspends renders every hook, then is thrown away with the previous tree still mounted.

import { act, render, screen } from "@testing-library/react";
import { Suspense, useState } from "react";
import { describe, expect, it } from "vitest";
import { createFixtureBridge } from "#renderer/services/platform/bridge.fixture.js";
import { type PlatformBridge } from "#renderer/services/platform/bridge.js";
import { WAITING_FOR_INPUT_SCENARIO } from "#fixtures/scenarios/waiting-for-input.js";
import { SuspendsWhenAsked, abandonOneRenderPass } from "#test/helpers/abandoned-pass.js";
import { useSettlementIdentities, type SettlementIdentities } from "./useSettlementIdentities.js";

/**
 * The hook under a tree that can re-address and suspend in one transition. `readdress` is
 * handed back through a holder because it must fire outside React's render.
 */
function ComposerHarness(props: {
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
      <ComposerHarness
        bridge={createFixtureBridge({ scenario: WAITING_FOR_INPUT_SCENARIO }).bridge}
        seen={seen}
        readdress={readdress}
      />,
    );
    const issued = seen.current?.issue("send");

    await abandonOneRenderPass(() => {
      readdress.current?.();
    });

    // The discarded pass ran this hook under the new draft key; written during that render,
    // the mirrors would name a visit nothing committed.
    expect(screen.queryByText("composer")).not.toBeNull();
    expect(issued).toBeDefined();
    expect(seen.current?.isCurrent(issued as NonNullable<typeof issued>)).toBe(true);
  });

  it("negative control: a committed re-address retires the earlier visit's act", () => {
    // Without this, the case above would pass a hook that called every settlement current.
    const seen: { current: SettlementIdentities | undefined } = { current: undefined };
    const readdress: { current: (() => void) | undefined } = { current: undefined };
    render(
      <ComposerHarness
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
