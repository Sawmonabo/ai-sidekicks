// Preview is consent: a rewind is never a button that fires.
//
// The two claims worth a unit here are the two refusals this surface raises BEFORE
// the wire, because both of them protect against destroying a tail for nothing: a
// rewind with no target position (the cut is daemon-supplied and the console
// computes none) and a composite whose replacement is only whitespace.
//
// The dispatch path is driven through the real surface hook against a stub bridge,
// so a request that did go out is observable as a recorded wire call rather than as
// a spy on a function the component was handed.
//
// The third claim is what the form does AFTER it dispatched: it closes on a
// settlement that landed and stays open, with the body intact, on every arm that did
// not. Both are driven by scripting what the stub answers with, so the arm under
// test is the daemon's own answer rather than a state the component was handed.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RunState } from "@ai-sidekicks/contracts";

import type { ConsoleBridge } from "../../bridge/index.js";
import { RunInterventionComposer, type ComposedControl } from "./RunInterventionComposer.js";
import { useRunControlSurface } from "./run-control-surface.js";
import { RunStateProjection } from "./run-state-feed.js";

const RUN_ID = "b3f0a1c2-4d5e-4f60-8a71-9c2d3e4f5061";

interface RecordedCall {
  readonly method: string;
  readonly params: unknown;
}

/** What the stub daemon answers one call with. Throwing is the refusal arm. */
type ScriptedAnswer = () => unknown;

/** The applied settlement every case that is not about settlement rides on. */
const APPLIED_ROLLBACK: ScriptedAnswer = () => ({
  interventionId: "d5f2c3e4-6071-4182-ac93-1e4f50617283",
  interventionType: "rollback",
  state: "applied",
  runVersion: 9,
  result: { disposition: "conversation-only" },
});

function stubBridge(calls: RecordedCall[], answer: ScriptedAnswer): ConsoleBridge {
  return {
    sidekicks: {
      daemon: {
        call: async (method: string, params: unknown): Promise<unknown> => {
          calls.push({ method, params });
          return answer();
        },
        subscribe: () => () => undefined,
      },
    },
    growth: {},
    source: "fixture",
    scenarioEngine: undefined,
  } as unknown as ConsoleBridge;
}

function runAt(state: RunState, runVersion = 8) {
  const fold = new RunStateProjection();
  fold.accept({
    runId: RUN_ID,
    runVersion,
    previousState: "queued",
    currentState: state,
    timestamp: "2026-01-01T16:00:00.000Z",
  });
  const run = fold.runs()[0];
  if (run === undefined) {
    throw new Error("the fold produced no run");
  }
  return run;
}

function ComposerHarness(props: {
  readonly control: ComposedControl;
  readonly calls: RecordedCall[];
  readonly answer: ScriptedAnswer;
  readonly onDismiss: () => void;
}): React.JSX.Element {
  const surface = useRunControlSurface(stubBridge(props.calls, props.answer));
  return (
    <RunInterventionComposer
      run={runAt("paused")}
      control={props.control}
      surface={surface}
      onDismiss={props.onDismiss}
    />
  );
}

function renderComposer(
  control: ComposedControl,
  answer: ScriptedAnswer = APPLIED_ROLLBACK,
): {
  container: HTMLElement;
  calls: RecordedCall[];
  dismissCount: () => number;
} {
  const calls: RecordedCall[] = [];
  let dismissals = 0;
  const { container } = render(
    <ComposerHarness
      control={control}
      calls={calls}
      answer={answer}
      onDismiss={() => {
        dismissals += 1;
      }}
    />,
  );
  return { container, calls, dismissCount: () => dismissals };
}

function bodyValue(container: HTMLElement): string {
  const body = container.querySelector(".meridian-run-composer__body");
  if (!(body instanceof HTMLTextAreaElement)) {
    throw new Error("the composer drew no body field");
  }
  return body.value;
}

function typeInto(element: Element | null, value: string): void {
  if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) {
    throw new Error("the composer drew no field to type into");
  }
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      element instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

// Awaited, because a confirm that reaches the wire settles asynchronously: the
// state update carrying the outcome lands after the click returns, and an
// unawaited act() would leave it outside the boundary React asserts on.
async function submit(container: HTMLElement): Promise<void> {
  const confirm = container.querySelector(".meridian-run-composer__confirm");
  if (!(confirm instanceof HTMLButtonElement)) {
    throw new Error("the composer drew no confirm");
  }
  await act(async () => {
    confirm.click();
  });
}

describe("preview is consent", () => {
  it("shows the scope and the guard before any confirm exists to press", () => {
    const { container } = renderComposer("rollback");
    const preview = container.querySelector(".meridian-run-composer__preview");
    expect(preview).not.toBeNull();
    expect(preview?.textContent).toContain(RUN_ID);
    expect(preview?.textContent).toContain("run version 8");
    expect(preview?.textContent).toContain("paused at the confirmed position");
  });

  it("negative control: the steer arm draws no rewind preview", () => {
    // Without this the case above would pass over a component that rendered the
    // preview unconditionally, which would promise a rewind to somebody steering.
    const { container } = renderComposer("steer");
    expect(container.querySelector(".meridian-run-composer__preview")).toBeNull();
  });
});

describe("the refusals raised before the wire", async () => {
  it("refuses a rewind with no target position, and sends nothing", async () => {
    const { container, calls } = renderComposer("rollback");
    await submit(container);
    expect(calls).toHaveLength(0);
    expect(container.textContent).toContain("target-position-unnamed");
  });

  it("refuses a target that is not a whole position, and sends nothing", async () => {
    // The prefix parse this replaces read `4oops` as 4 and dispatched a destructive
    // rewind to a position nobody typed.
    const { container, calls } = renderComposer("rollback");
    typeInto(container.querySelector(".meridian-run-composer__position"), "4oops");
    await submit(container);
    expect(calls).toHaveLength(0);
    expect(container.textContent).toContain("target-position-unreadable");
  });

  it("refuses a composite whose replacement is only whitespace, and sends nothing", async () => {
    const { container, calls } = renderComposer("rollback");
    typeInto(container.querySelector(".meridian-run-composer__position"), "4");
    typeInto(container.querySelector(".meridian-run-composer__body"), "   ");
    await submit(container);
    expect(calls).toHaveLength(0);
    expect(container.textContent).toContain("empty-replacement");
  });

  it("refuses an empty steer, and sends nothing", async () => {
    const { container, calls } = renderComposer("steer");
    await submit(container);
    expect(calls).toHaveLength(0);
    expect(container.textContent).toContain("empty-directive");
  });

  it("negative control: a named position with no replacement dispatches a bare rewind", async () => {
    // Proves the refusals above are about the two named conditions rather than a
    // composer that never sends anything.
    const { container, calls } = renderComposer("rollback");
    typeInto(container.querySelector(".meridian-run-composer__position"), "4");
    await submit(container);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("run.intervene");
    expect(calls[0]?.params).toMatchObject({ type: "rollback", targetPosition: 4 });
    expect(calls[0]?.params).not.toHaveProperty("replacementSend");
  });
});

describe("the composite says what it did", () => {
  it("says the replacement is queued and sends on the next resume, never that it was sent", () => {
    const { container } = renderComposer("rollback");
    typeInto(container.querySelector(".meridian-run-composer__body"), "try this instead");
    const composite = container.querySelector(".meridian-run-composer__composite");
    expect(composite?.textContent).toContain("queued against the run");
    expect(composite?.textContent).toContain("next resume");
    expect(composite?.textContent).not.toContain("re-sent");
  });

  it("queues the replacement byte-identical, indentation and blank line included", async () => {
    // The trim used to run on the way to the wire rather than only on the blank
    // test, so a pasted block reached the queue having lost the shape that was the
    // reason for pasting it. The negative control is the dispatched params: the
    // resolution is the same composite either way.
    const indented = "  if (ready) {\n    ship();\n  }\n\n";
    const { container, calls } = renderComposer("rollback");
    typeInto(container.querySelector(".meridian-run-composer__position"), "4");
    typeInto(container.querySelector(".meridian-run-composer__body"), indented);
    await submit(container);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toMatchObject({
      type: "rollback",
      replacementSend: { content: indented },
    });
  });

  it("carries the replacement on the one intervention rather than as a second call", async () => {
    const { container, calls } = renderComposer("rollback");
    typeInto(container.querySelector(".meridian-run-composer__position"), "4");
    typeInto(container.querySelector(".meridian-run-composer__body"), "try this instead");
    await submit(container);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toMatchObject({
      type: "rollback",
      replacementSend: { content: "try this instead" },
    });
  });
});

describe("the composer outlives its dispatch", () => {
  const REJECTED_ROLLBACK: ScriptedAnswer = () => ({
    interventionId: "d5f2c3e4-6071-4182-ac93-1e4f50617283",
    interventionType: "rollback",
    state: "rejected",
    rejectionReason: "target-position-not-a-boundary",
    runVersion: 9,
  });

  const TRANSPORT_REJECTION: ScriptedAnswer = () => {
    throw { code: "run.invalid_transition", message: "the run is not in a rewindable state" };
  };

  it("keeps the replacement text when the dispatch is refused at transport", async () => {
    const { container, dismissCount } = renderComposer("rollback", TRANSPORT_REJECTION);
    typeInto(container.querySelector(".meridian-run-composer__position"), "4");
    typeInto(container.querySelector(".meridian-run-composer__body"), "try this instead");
    await submit(container);
    // The one thing the participant cannot reproduce is the one thing that used to
    // be dropped: the form closed the moment the dispatch STARTED.
    expect(dismissCount()).toBe(0);
    expect(bodyValue(container)).toBe("try this instead");
    expect(container.textContent).toContain("run.invalid_transition");
  });

  it("keeps the text and shows the daemon's own reason when the intervention is rejected", async () => {
    const { container, dismissCount } = renderComposer("rollback", REJECTED_ROLLBACK);
    typeInto(container.querySelector(".meridian-run-composer__position"), "4");
    typeInto(container.querySelector(".meridian-run-composer__body"), "try this instead");
    await submit(container);
    expect(dismissCount()).toBe(0);
    expect(bodyValue(container)).toBe("try this instead");
    expect(container.textContent).toContain("target-position-not-a-boundary");
  });

  it("keeps a refused steer's directive rather than dropping it", async () => {
    const { container, dismissCount } = renderComposer("steer", TRANSPORT_REJECTION);
    typeInto(container.querySelector(".meridian-run-composer__body"), "stop editing that file");
    await submit(container);
    expect(dismissCount()).toBe(0);
    expect(bodyValue(container)).toBe("stop editing that file");
  });

  it("negative control: a settlement that landed closes the composer", async () => {
    // Without this the three cases above would pass over a form that never closed at
    // all, which would leave a landed rewind sitting behind its own composer.
    const { container, dismissCount } = renderComposer("rollback");
    typeInto(container.querySelector(".meridian-run-composer__position"), "4");
    await submit(container);
    expect(dismissCount()).toBe(1);
  });

  it("latches the confirm while the dispatch is in flight, so one body sends once", async () => {
    // A never-settling answer holds the form in its sending state; the second submit
    // arrives the way a keyboard one does, through the form rather than the button.
    const { container, calls } = renderComposer("rollback", () => new Promise(() => undefined));
    typeInto(container.querySelector(".meridian-run-composer__position"), "4");
    await submit(container);
    const form = container.querySelector(".meridian-run-composer");
    if (!(form instanceof HTMLFormElement)) {
      throw new Error("the composer drew no form");
    }
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(calls).toHaveLength(1);
  });
});

describe("the comparand is the newer of the two readings", () => {
  // One bridge for the surface's whole life, so the dispatcher's cache survives a
  // rerender; the composer itself is remounted (keyed) each time the stream's
  // reading of the run moves. The applied answer reports version 9, which the
  // dispatcher caches; the stream then reports 10.
  function StableHarness(props: {
    readonly bridge: ConsoleBridge;
    readonly runVersion: number;
  }): React.JSX.Element {
    const surface = useRunControlSurface(props.bridge);
    return (
      <RunInterventionComposer
        key={props.runVersion}
        run={runAt("paused", props.runVersion)}
        control="rollback"
        surface={surface}
        onDismiss={() => undefined}
      />
    );
  }

  async function rewindAt(container: HTMLElement): Promise<void> {
    typeInto(container.querySelector(".meridian-run-composer__position"), "4");
    await submit(container);
  }

  it("sends the stream's version once it has moved past the cached settlement", async () => {
    const calls: RecordedCall[] = [];
    const bridge = stubBridge(calls, APPLIED_ROLLBACK);
    const { container, rerender } = render(<StableHarness bridge={bridge} runVersion={8} />);
    await rewindAt(container);
    expect(calls[0]?.params).toMatchObject({ expectedRunVersion: 8 });
    rerender(<StableHarness bridge={bridge} runVersion={10} />);
    await rewindAt(container);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.params).toMatchObject({ expectedRunVersion: 10 });
  });

  it("negative control: the cached settlement still wins over a stream that is behind it", async () => {
    const calls: RecordedCall[] = [];
    const bridge = stubBridge(calls, APPLIED_ROLLBACK);
    const { container, rerender } = render(<StableHarness bridge={bridge} runVersion={8} />);
    await rewindAt(container);
    rerender(<StableHarness bridge={bridge} runVersion={8} />);
    await rewindAt(container);
    expect(calls[1]?.params).toMatchObject({ expectedRunVersion: 9 });
  });
});
