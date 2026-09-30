// A row body reading its own lane through the real composition: a mounted engine, the provider
// the feed publishes, and a row body asking for its lane. The second case is why this is a
// subscription per row rather than a context value: a context carrying the text would
// re-render every row in the window on every drained frame.

import { act, render } from "@testing-library/react";
import { memo, useRef } from "react";
import { describe, expect, it } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { useAnimationFrameCoordinator } from "../../hooks/useAnimationFrameCoordinator.js";
import { TWO_FRAME_REVEAL_SOURCE } from "../reveal.test-support.js";
import { useReveal, type RevealBinding } from "../hooks/useReveal.js";
import { useRowReveal } from "../hooks/useRowReveal.js";
import { RowRevealProvider } from "./RowRevealProvider.js";

const FIRST_LANE = "session-1:41";
const SECOND_LANE = "session-1:42";

/**
 * One row body: its lane's published text and how often it has rendered. Memoized like
 * `VirtualRow`: the feed re-renders on every drained frame with identical props for the rows
 * above the one that moved, so only a row's own subscription can wake it.
 */
const RevealProbe = memo(function RevealProbe(props: {
  readonly laneId: string;
}): React.JSX.Element {
  const renderCount = useRef(0);
  renderCount.current += 1;
  const liveText = useRowReveal(props.laneId);
  return (
    <p data-lane={props.laneId} data-renders={renderCount.current}>
      {liveText ?? ""}
    </p>
  );
});

/**
 * The real composition: a feed's engine, its provider, and the row bodies under it. The binding
 * escapes through a callback because the engine's ownership is under test; an engine built
 * beside the provider would prove nothing about the mount.
 */
function RevealHost(props: {
  readonly clock: ManualClock;
  readonly laneIds: readonly string[];
  readonly onBinding: (binding: RevealBinding) => void;
}): React.JSX.Element {
  const reveal = useReveal({ frameCoordinator: useAnimationFrameCoordinator(props.clock) });
  props.onBinding(reveal);
  return (
    <RowRevealProvider channel={reveal.channel}>
      {props.laneIds.map((laneId) => (
        <RevealProbe key={laneId} laneId={laneId} />
      ))}
    </RowRevealProvider>
  );
}

interface MountedReveal {
  readonly container: HTMLElement;
  ingest: (laneId: string, text: string) => void;
}

function mountReveal(clock: ManualClock, laneIds: readonly string[]): MountedReveal {
  let binding: RevealBinding | undefined;
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

  it("renders nothing at all outside a transcript, rather than refusing to mount", () => {
    // An absent reveal channel is the ordinary state of every row in a settled log, so it
    // answers rather than refuses.
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
