// A row body reading its own lane — the path that did not exist.
//
// `ledger/cards/bodies/MachineBody.tsx` has taken `liveText` since it was written and takes
// it in preference to a stored body; nothing ever passed one. These cases drive the
// real composition — a mounted engine, the provider the feed publishes, and a row
// body asking for its own lane — so what is pinned is the delivery rather than either
// half of it.
//
// The second case is the reason this is a subscription per row rather than a value on
// the context: `card-props.ts` objects that a subscribed card "would re-render on
// frames its own text did not change in", and a context carrying the text would do
// exactly that to every row in the window on every drained frame.

import { act, render } from "@testing-library/react";
import { memo, useRef } from "react";
import { describe, expect, it } from "vitest";

import { ManualClock } from "../../../core/index.js";
import { TWO_FRAME_REVEAL_SOURCE } from "./reveal.test-support.js";
import { useLedgerReveal, type LedgerRevealBinding } from "./reveal-binding.js";
import { LedgerRowRevealProvider, useLedgerRowReveal } from "./RowRevealProvider.js";

const FIRST_LANE = "session-1:41";
const SECOND_LANE = "session-1:42";

/**
 * One row body: its lane's published text, and how often it has been rendered.
 *
 * MEMOIZED, because `LedgerViewport`'s row mount is: the feed re-renders on every
 * drained frame and the rows above the one that moved have identical props, so the
 * only thing that can wake a row body is its own subscription. A probe without the
 * memo would model a viewport this console does not have.
 */
const RevealProbe = memo(function RevealProbe(props: {
  readonly laneId: string;
}): React.JSX.Element {
  const renderCount = useRef(0);
  renderCount.current += 1;
  const liveText = useLedgerRowReveal(props.laneId);
  return (
    <p data-lane={props.laneId} data-renders={renderCount.current}>
      {liveText ?? ""}
    </p>
  );
});

/**
 * The real composition: a feed's engine, its provider, and the row bodies under it.
 *
 * The binding escapes through a callback rather than being minted outside the tree,
 * because the engine's ownership is the thing under test — a case that constructed
 * one beside the provider would prove the channel works and nothing about the mount.
 */
function RevealHost(props: {
  readonly clock: ManualClock;
  readonly laneIds: readonly string[];
  readonly onBinding: (binding: LedgerRevealBinding) => void;
}): React.JSX.Element {
  const reveal = useLedgerReveal({ clock: props.clock });
  props.onBinding(reveal);
  return (
    <LedgerRowRevealProvider channel={reveal.channel}>
      {props.laneIds.map((laneId) => (
        <RevealProbe key={laneId} laneId={laneId} />
      ))}
    </LedgerRowRevealProvider>
  );
}

interface MountedReveal {
  readonly container: HTMLElement;
  ingest: (laneId: string, text: string) => void;
}

function mountReveal(clock: ManualClock, laneIds: readonly string[]): MountedReveal {
  let binding: LedgerRevealBinding | undefined;
  const { container } = render(
    <RevealHost
      clock={clock}
      laneIds={laneIds}
      onBinding={(current) => {
        binding = current;
      }}
    />,
  );
  return {
    container,
    ingest: (laneId, text) => {
      act(() => {
        binding?.ingest({ laneId, mode: "direct", text });
      });
    },
  };
}

function probeFor(container: HTMLElement, laneId: string): HTMLElement {
  const probe = container.querySelector<HTMLElement>(`[data-lane="${laneId}"]`);
  if (probe === null) {
    throw new Error(`no row body was mounted for lane ${laneId}`);
  }
  return probe;
}

describe("a row body reading its lane", () => {
  it("renders the text the engine revealed, and not the delta it was handed", () => {
    const clock = new ManualClock();
    const mounted = mountReveal(clock, [FIRST_LANE]);
    expect(probeFor(mounted.container, FIRST_LANE).textContent).toBe("");

    mounted.ingest(FIRST_LANE, TWO_FRAME_REVEAL_SOURCE);
    act(() => {
      clock.runFrame();
    });

    const revealed = probeFor(mounted.container, FIRST_LANE).textContent ?? "";
    expect(revealed.length).toBeGreaterThan(0);
    expect(revealed.length).toBeLessThan(TWO_FRAME_REVEAL_SOURCE.length);
    expect(TWO_FRAME_REVEAL_SOURCE.startsWith(revealed)).toBe(true);
  });

  it("negative control: a row whose lane nothing streams into stays empty", () => {
    // Without this the case above would pass over a channel that answered every lane
    // with whatever was last ingested anywhere.
    const clock = new ManualClock();
    const mounted = mountReveal(clock, [FIRST_LANE, SECOND_LANE]);
    mounted.ingest(FIRST_LANE, TWO_FRAME_REVEAL_SOURCE);
    act(() => {
      clock.runFrame();
    });
    expect(probeFor(mounted.container, SECOND_LANE).textContent).toBe("");
  });

  it("renders nothing at all outside a ledger, rather than refusing to mount", () => {
    // The lease channel throws here and is right to: a discarded write looks like a
    // row that will not open. An absent reveal channel is the ordinary state of every
    // row in a settled log, so it answers rather than refuses.
    const { container } = render(<RevealProbe laneId={FIRST_LANE} />);
    expect(probeFor(container, FIRST_LANE).textContent).toBe("");
  });
});

describe("what a drained frame costs the rows it did not move", () => {
  it("re-renders only the row whose own text changed", () => {
    const clock = new ManualClock();
    const mounted = mountReveal(clock, [FIRST_LANE, SECOND_LANE]);
    const rendersBefore = probeFor(mounted.container, SECOND_LANE).dataset["renders"];

    mounted.ingest(FIRST_LANE, TWO_FRAME_REVEAL_SOURCE);
    act(() => {
      clock.runFrame();
    });

    expect(probeFor(mounted.container, SECOND_LANE).dataset["renders"]).toBe(rendersBefore);
    // And the negative control rides the same reading: the lane that DID move
    // re-rendered, so the count above is a bailout rather than a subscription that
    // never fired.
    expect(probeFor(mounted.container, FIRST_LANE).dataset["renders"]).not.toBe(rendersBefore);
  });
});
