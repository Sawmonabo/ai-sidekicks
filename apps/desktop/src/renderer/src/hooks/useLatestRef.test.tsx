// The ref moves at the commit, so a pass React throws away moves nothing.
//
// A render that really runs and never becomes a frame is built, not described: a transition
// that re-props the tree and suspends runs every component body in it and is then parked,
// with the committed tree still on screen. Nothing in this package reaches that state today;
// the cases keep callbacks built from this hook correct for the first concurrent feature
// that does.
//
// The negative control is a ref assigned in the render body. The claim cases drive the real
// hook; the foil is the arrangement that has to fail before a green result from them means
// anything.

import { render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it } from "vitest";

import { SuspendsWhenAsked, abandonOneRenderPass } from "@test/helpers/abandoned-pass.js";
import { useLatestRef } from "./useLatestRef.js";

/** The committed value every case starts at, and the one a discarded pass proposes. */
const COMMITTED_VALUE = "committed";
const ABANDONED_VALUE = "abandoned";

/** What a case holds onto across a render it does not control. */
interface ProbeHandles {
  readonly readLatest: { current: (() => string) | undefined };
  readonly proposeAbandonedValue: { current: (() => void) | undefined };
}

function probeHandles(): ProbeHandles {
  return { readLatest: { current: undefined }, proposeAbandonedValue: { current: undefined } };
}

/** The hook under a tree that can re-value itself and suspend in one transition. */
function LatestRefHost(props: { readonly handles: ProbeHandles }): React.JSX.Element {
  const [value, setValue] = useState(COMMITTED_VALUE);
  const [suspend, setSuspend] = useState(false);
  const latest = useLatestRef(value);
  props.handles.readLatest.current = () => latest.current;
  props.handles.proposeAbandonedValue.current = () => {
    setValue(ABANDONED_VALUE);
    setSuspend(true);
  };
  return (
    <>
      <SuspendsWhenAsked suspend={suspend} />
      <p>{value}</p>
    </>
  );
}

/** The same tree with the ref assigned in the render body. */
function RenderBodyRefHost(props: { readonly handles: ProbeHandles }): React.JSX.Element {
  const [value, setValue] = useState(COMMITTED_VALUE);
  const [suspend, setSuspend] = useState(false);
  const latest = useRef(value);
  latest.current = value;
  props.handles.readLatest.current = () => latest.current;
  props.handles.proposeAbandonedValue.current = () => {
    setValue(ABANDONED_VALUE);
    setSuspend(true);
  };
  return (
    <>
      <SuspendsWhenAsked suspend={suspend} />
      <p>{value}</p>
    </>
  );
}

describe("the latest-committed ref", () => {
  it("reads the committed value once the tree is on screen", () => {
    const handles = probeHandles();
    render(<LatestRefHost handles={handles} />);

    expect(handles.readLatest.current?.()).toBe(COMMITTED_VALUE);
  });

  it("still reads the committed value after a pass React never commits", async () => {
    const handles = probeHandles();
    render(<LatestRefHost handles={handles} />);

    await abandonOneRenderPass(() => {
      handles.proposeAbandonedValue.current?.();
    });

    // The committed tree is on screen (no fallback, no re-render), so a callback invoked now
    // must act on what that tree supplied.
    expect(screen.queryByText(COMMITTED_VALUE)).not.toBeNull();
    expect(handles.readLatest.current?.()).toBe(COMMITTED_VALUE);
  });

  it("negative control: the render-body assignment this replaced takes the discarded value", async () => {
    // Without this the case above would pass over any arrangement, including one that never
    // wrote the ref. The discarded pass ran and its body assigned, so the tree still on screen
    // invokes against a value belonging to a render nobody saw.
    const handles = probeHandles();
    render(<RenderBodyRefHost handles={handles} />);

    await abandonOneRenderPass(() => {
      handles.proposeAbandonedValue.current?.();
    });

    expect(screen.queryByText(COMMITTED_VALUE)).not.toBeNull();
    expect(handles.readLatest.current?.()).toBe(ABANDONED_VALUE);
  });
});
