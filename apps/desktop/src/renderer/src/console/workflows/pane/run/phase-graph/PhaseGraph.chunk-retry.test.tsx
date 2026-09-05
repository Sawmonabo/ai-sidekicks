// A chunk fetch that failed once, asked for again.
//
// SEPARATE FROM `PhaseGraph.chunk-refusal.test.tsx` BECAUSE THE SUBSTITUTED LOADER IS A
// DIFFERENT ONE. That file's premise is a loader that always refuses, which is what lets
// it say what a refusal renders; every case here scripts a SEQUENCE of answers, because
// the claim is about what the second ask gets. A `vi.mock` is file-scoped, so the two
// premises cannot reach each other.
//
// WHY THE ARM IS WORTH A SUITE. `phase-graph-loader.ts` drops its memo on a rejection
// precisely so a second `load()` re-fetches — the expected cause is a transient network
// or disk failure — and the only caller latched the refusal under dependencies that
// never move again. The hardening existed and nothing on screen could reach it.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PhaseGraph } from "./PhaseGraph.js";
import type { PhaseGraphNode } from "./phase-topology.js";

/**
 * The answers this case has scripted for the chunk, in order, and how many were asked.
 *
 * A box hoisted with the mock rather than a value closed over: `vi.mock` factories are
 * lifted above the imports, so a plain binding is not initialised when the factory runs.
 * The queue is read at CALL time, which is what lets one substitution serve a case whose
 * first ask fails and whose second succeeds.
 */
const chunkAnswers = vi.hoisted(() => ({
  queue: [] as (() => Promise<unknown>)[],
  asks: 0,
}));

vi.mock("./phase-graph-loader.js", () => ({
  phaseGraphLoader: {
    load: (): Promise<unknown> => {
      chunkAnswers.asks += 1;
      const answer = chunkAnswers.queue.shift();
      // Refusing rather than repeating the last answer: a case that asked more times
      // than it scripted has proved something other than what it claims to.
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

const TWO_PHASES: readonly PhaseGraphNode[] = [
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
  return () => Promise.resolve({ PhaseGraphCanvas: () => DRAWN_CANVAS_TEXT });
}

/** An ask that never settles, which is what "still in flight" is. */
function neverSettling(): () => Promise<never> {
  return () => new Promise<never>(() => undefined);
}

function renderGraph(answers: readonly (() => Promise<unknown>)[]): HTMLElement {
  chunkAnswers.queue = [...answers];
  const { container } = render(<PhaseGraph phases={TWO_PHASES} label="Phase sequence" />);
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
    // The skeleton is a claim that a fetch is running, so the ask is asserted beside
    // it: a press that only reset the state would put a wait on screen over nothing.
    expect(chunkAnswers.asks).toBe(2);
  });

  it("negative control: without the press the refusal stands and nothing is re-asked", async () => {
    // Without this the cases above would pass over a component that re-fetched on every
    // render — which would turn a refused chunk into a fetch loop and would mean the
    // control proved nothing about the press.
    const container = renderGraph([refusing(), arriving()]);
    await retryControl(container);

    // A render the press did not cause: the same props, handed over again.
    render(<PhaseGraph phases={TWO_PHASES} label="Phase sequence" />, {
      container,
      baseElement: container,
    });

    expect(container.querySelector(".meridian-refusal--banner")).not.toBeNull();
    expect(chunkAnswers.asks).toBe(1);
  });

  it("negative control: the read-in-flight absence offers no way to ask again", async () => {
    // The grammar's own split, asserted: `action` is what to do about a refusal, and a
    // chunk still coming has nothing to offer — a control there would invite a person
    // to restart a fetch that had not finished.
    const container = renderGraph([neverSettling()]);

    await waitFor(() => {
      expect(container.querySelector(".meridian-nothing")).not.toBeNull();
    });
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});
