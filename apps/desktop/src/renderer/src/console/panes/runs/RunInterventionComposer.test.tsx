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

function stubBridge(calls: RecordedCall[]): ConsoleBridge {
  return {
    sidekicks: {
      daemon: {
        call: async (method: string, params: unknown): Promise<unknown> => {
          calls.push({ method, params });
          return {
            interventionId: "d5f2c3e4-6071-4182-ac93-1e4f50617283",
            interventionType: "rollback",
            state: "applied",
            runVersion: 9,
            result: { disposition: "conversation-only" },
          };
        },
        subscribe: () => () => undefined,
      },
    },
    growth: {},
    source: "fixture",
    scenarioEngine: undefined,
  } as unknown as ConsoleBridge;
}

function runAt(state: RunState) {
  const fold = new RunStateProjection();
  fold.accept({
    runId: RUN_ID,
    runVersion: 8,
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
}): React.JSX.Element {
  const surface = useRunControlSurface(stubBridge(props.calls));
  return (
    <RunInterventionComposer
      run={runAt("paused")}
      control={props.control}
      surface={surface}
      onDismiss={() => undefined}
    />
  );
}

function renderComposer(control: ComposedControl): {
  container: HTMLElement;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const { container } = render(<ComposerHarness control={control} calls={calls} />);
  return { container, calls };
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

function submit(container: HTMLElement): void {
  const confirm = container.querySelector(".meridian-run-composer__confirm");
  if (!(confirm instanceof HTMLButtonElement)) {
    throw new Error("the composer drew no confirm");
  }
  act(() => {
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

describe("the two refusals raised before the wire", () => {
  it("refuses a rewind with no target position, and sends nothing", () => {
    const { container, calls } = renderComposer("rollback");
    submit(container);
    expect(calls).toHaveLength(0);
    expect(container.textContent).toContain("target-position-unnamed");
  });

  it("refuses a composite whose replacement is only whitespace, and sends nothing", () => {
    const { container, calls } = renderComposer("rollback");
    typeInto(container.querySelector(".meridian-run-composer__position"), "4");
    typeInto(container.querySelector(".meridian-run-composer__body"), "   ");
    submit(container);
    expect(calls).toHaveLength(0);
    expect(container.textContent).toContain("empty-replacement");
  });

  it("refuses an empty steer, and sends nothing", () => {
    const { container, calls } = renderComposer("steer");
    submit(container);
    expect(calls).toHaveLength(0);
    expect(container.textContent).toContain("empty-directive");
  });

  it("negative control: a named position with no replacement dispatches a bare rewind", () => {
    // Proves the refusals above are about the two named conditions rather than a
    // composer that never sends anything.
    const { container, calls } = renderComposer("rollback");
    typeInto(container.querySelector(".meridian-run-composer__position"), "4");
    submit(container);
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

  it("carries the replacement on the one intervention rather than as a second call", () => {
    const { container, calls } = renderComposer("rollback");
    typeInto(container.querySelector(".meridian-run-composer__position"), "4");
    typeInto(container.querySelector(".meridian-run-composer__body"), "try this instead");
    submit(container);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toMatchObject({
      type: "rollback",
      replacementSend: { content: "try this instead" },
    });
  });
});
