// A chunk fetch that failed once, asked for again. Separate from `RunGraph.chunk-refusal.test.tsx`
// because each case here scripts a sequence of answers, where that file's loader always
// refuses, and a `vi.mock` is file-scoped. The loader drops its memo on a rejection so a second
// `load()` re-fetches; this suite proves the screen can reach that.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RunGraph } from "./RunGraph.js";
import type { RunGraphNode } from "./phase-topology.js";

/**
 * The answers this case has scripted for the chunk, in order, and how many were asked.
 *
 * Hoisted with the mock because `vi.mock` factories run above the imports; read at call time
 * so one substitution serves a case whose first ask fails and second succeeds.
 */
const chunkAnswers = vi.hoisted(() => ({
  queue: [] as (() => Promise<unknown>)[],
  asks: 0,
}));

vi.mock("./run-graph-loader.js", () => ({
  runGraphLoader: {
    load: (): Promise<unknown> => {
      chunkAnswers.asks += 1;
      const answer = chunkAnswers.queue.shift();
      // Refusing rather than repeating the last answer: a case that asked more times than it
      // scripted has proved something other than what it claims to.
      return answer === undefined
        ? Promise.reject(new Error("the chunk was asked for more times than this case scripted"))
        : answer();
    },
  },
}));

/** What the substituted chunk resolves to, said in text a case can read off the box. */
const DRAWN_CANVAS_TEXT = "the graph chunk arrived";

/** The rejection a transient fetch failure arrives as. */
const TRANSIENT_FETCH_FAILURE = new Error("Failed to fetch dynamically imported module");

const TWO_PHASES: readonly RunGraphNode[] = [
  {
    phaseId: "plan",
    displayName: "Plan",
    state: "completed",
    gateState: "open",
    parkAttention: undefined,
  },
  {
    phaseId: "build",
    displayName: "Build",
    state: "running",
    gateState: "closed",
    parkAttention: undefined,
  },
];

/** An ask that refuses, as the browser refuses one. */
function refusing(): () => Promise<never> {
  return () => Promise.reject(TRANSIENT_FETCH_FAILURE);
}

/** An ask that arrives, carrying a canvas a case can see on screen. */
function arriving(): () => Promise<unknown> {
  return () => Promise.resolve({ RunGraphCanvas: () => DRAWN_CANVAS_TEXT });
}

/** An ask that never settles, which is what "still in flight" is. */
function neverSettling(): () => Promise<never> {
  return () => new Promise<never>(() => undefined);
}

function renderGraph(answers: readonly (() => Promise<unknown>)[]): HTMLElement {
  chunkAnswers.queue = [...answers];
  const { container } = render(<RunGraph phases={TWO_PHASES} label="Phase sequence" />);
  return container;
}

/** The control the refusal offers, once it is on screen. */
async function retryControl(container: HTMLElement): Promise<HTMLElement> {
  await waitFor(() => {
    expect(container.querySelector(".meridian-refusal--banner")).not.toBeNull();
  });
  return screen.getByRole("button", { name: /try loading the graph again/iu });
}

describe("a chunk fetch that can be asked for again", () => {
  beforeEach(() => {
    chunkAnswers.asks = 0;
    chunkAnswers.queue = [];
  });

  it("draws the graph when the second ask arrives", async () => {
    const container = renderGraph([refusing(), arriving()]);

    fireEvent.click(await retryControl(container));

    await waitFor(() => {
      expect(container.textContent).toContain(DRAWN_CANVAS_TEXT);
    });
    // The refusal goes with it rather than standing beside a drawn canvas.
    expect(container.querySelector(".meridian-refusal--banner")).toBeNull();
    expect(chunkAnswers.asks).toBe(2);
  });

  it("says a fetch is in flight again rather than holding the refusal beside it", async () => {
    const container = renderGraph([refusing(), neverSettling()]);

    fireEvent.click(await retryControl(container));

    await waitFor(() => {
      expect(container.querySelector(".meridian-nothing")).not.toBeNull();
    });
    expect(container.querySelector(".meridian-refusal--banner")).toBeNull();
    // The skeleton claims a fetch is running, so the ask is asserted beside it: a press that
    // only reset the state would put a wait on screen over nothing.
    expect(chunkAnswers.asks).toBe(2);
  });

  it("negative control: without the press the refusal stands and nothing is re-asked", async () => {
    // Without this, a component that re-fetched on every render (a fetch loop) would pass the
    // cases above.
    const container = renderGraph([refusing(), arriving()]);
    await retryControl(container);

    // A render the press did not cause: the same props, handed over again.
    render(<RunGraph phases={TWO_PHASES} label="Phase sequence" />, {
      container,
      baseElement: container,
    });

    expect(container.querySelector(".meridian-refusal--banner")).not.toBeNull();
    expect(chunkAnswers.asks).toBe(1);
  });

  it("negative control: the read-in-flight absence offers no way to ask again", async () => {
    // `action` is what to do about a refusal; a control beside a chunk still coming would
    // invite restarting a fetch that had not finished.
    const container = renderGraph([neverSettling()]);

    await waitFor(() => {
      expect(container.querySelector(".meridian-nothing")).not.toBeNull();
    });
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});
