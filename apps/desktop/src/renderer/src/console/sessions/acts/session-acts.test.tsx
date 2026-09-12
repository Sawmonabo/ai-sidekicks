// The ways in, driven against the scenario that scripts them.
//
// Every case here runs on the real fixture bridge playing `bring-your-history`, which
// is what makes them worth having: a stub could answer anything, and what these assert
// is that the SCENARIO reaches each arm — the import that runs to its terminal frame,
// and the import the node holds no reader for.
//
// AND THE IMPORT CASE ADVANCES THE SCENARIO CLOCK, because the fixture paces that
// feed against it: each progress reading is held until the frozen clock reaches the
// tick the script declares it at, so a case that only waited would wait forever. What
// it buys is that the intermediate running states are on screen to be asserted at all
// — before the pacing landed, all three readings arrived on one turn and React
// batched them into the terminal frame.
//
// THE IMPORT CASES DRIVE THE WHOLE ACTS BAR rather than the panel alone, because the
// import no longer lives in the panel: `SessionActs` holds it and the panel renders
// it, so a case that mounted the panel with a model of its own would be asserting
// against a composition this console does not produce. Reaching it through the create
// menu is what a person does and is the same two presses either way.
//
// AND THAT PANEL ARRIVES ON ITS OWN CHUNK, so reaching it is asynchronous now. The wait
// is `openImportDisclosure`'s — the one function every case presses through — rather
// than this file's, for the reason that helper was hoisted at all.

import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  BRING_YOUR_HISTORY_SCENARIO,
  PROVIDER_SESSION_IMPORT_PROGRESS_FRAMES,
} from "../../bridge/scenario/bring-your-history.js";
import { SessionActs } from "./SessionActs.js";
import { openImportDisclosure, QUIET_PREFERENCES } from "./session-acts.test-support.js";
import {
  createFixture,
  fixtureBridgeWithGrowth,
  growthServing,
} from "../../bridge/fixture/call-plane/bridge.test-support.js";
import { settle } from "../../core/settle.test-support.js";
import type { ConsoleBridge, GrowthImportProgress } from "../../bridge/index.js";

/** Type into one of a form's fields, the way a person does. */
function fill(container: HTMLElement, labelText: string, value: string): void {
  const field = [...container.querySelectorAll("label")].find((label) =>
    label.textContent?.startsWith(labelText),
  );
  const input = field?.querySelector("input");
  if (input === null || input === undefined) {
    throw new Error(`no field labelled ${labelText}`);
  }
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** The refusal code the surface rendered, or `undefined` where it rendered none. */
function refusalCode(container: HTMLElement): string | undefined {
  // The code rides the wire-figure span inside the refusal, which is the markup
  // `InlineRefusal` actually emits — read off the real component rather than off a
  // class this file wishes existed.
  return (
    container.querySelector(".meridian-refusal .meridian-figure--wire")?.textContent ?? undefined
  );
}

/** Mount the acts bar and disclose the import, the way somebody reaches it. */
async function renderImport(actsBridge: ConsoleBridge): Promise<HTMLElement> {
  const { container } = render(
    <SessionActs bridge={actsBridge} preferences={QUIET_PREFERENCES} onStart={() => undefined} />,
  );
  await openImportDisclosure(container);
  return container;
}

describe("importing a provider session", () => {
  it("runs the subscription to its terminal frame and renders the producer's words", async () => {
    const fixture = createFixture(BRING_YOUR_HISTORY_SCENARIO);
    const container = await renderImport(fixture.bridge);

    fill(container, "Provider", "claude");
    fill(container, "What to read", "~/.claude/threads/one.jsonl");
    submit(container);
    await settle();

    // Step-wise through the script's own ticks, on the fixture's advance surface. The
    // first reading is due at tick zero, so it is on screen before the clock moves;
    // each one after it is what the next advance releases, and the panel renders the
    // producer's own turn count at every step rather than only at the end.
    let elapsedMs = 0;
    for (const frame of PROVIDER_SESSION_IMPORT_PROGRESS_FRAMES) {
      fixture.engine.advance(frame.atMs - elapsedMs);
      elapsedMs = frame.atMs;
      await settle();
      expect(container.textContent).toContain(String(frame.progress.turnsSeen));
    }

    await waitFor(() => {
      expect(container.textContent).toContain("Ended");
    });
    expect(container.textContent).toContain("complete");
    expect(container.textContent).toContain("61");
  });

  it("refuses a provider this node holds no reader for, and subscribes to nothing", async () => {
    const container = await renderImport(bridge());

    fill(container, "Provider", "a-provider-nobody-reads");
    fill(container, "What to read", "~/somewhere");
    submit(container);

    await waitFor(() => {
      expect(refusalCode(container)).toBe("session.import_provider_unsupported");
    });
    // The begin never settled, so no import id exists and the progress line is absent
    // entirely — "nothing was asked" rather than an empty reading of a subscription.
    expect(container.querySelector(".meridian-session-import__progress")).toBeNull();
  });

  it("keeps the control refused while the progress stream is still reading", async () => {
    const stream = heldProgressStream();
    const container = await renderImport(
      fixtureBridgeWithGrowth(BRING_YOUR_HISTORY_SCENARIO, {
        providerSessionImportSubscribe: growthServing(stream.handle),
      }),
    );

    fill(container, "Provider", "claude");
    fill(container, "What to read", "~/.claude/threads/one.jsonl");
    submit(container);
    await settle();

    // The begin has answered — the id exists and the stream has spoken once — and the
    // import is nowhere near done. A control re-enabled here would let a second submit
    // replace the id and orphan this reading with nothing on screen reporting it.
    expect(container.textContent).toContain("7");
    expect(submitControl(container).disabled).toBe(true);
    expect(container.textContent).toContain("The last import is still being read.");

    stream.end();
    await settle();

    // And the moment the producer stops, the form is a form again.
    expect(container.textContent).toContain("Ended");
    expect(submitControl(container).disabled).toBe(false);
  });
});

/** The panel's own submit control, which is the last button its form carries. */
function submitControl(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector("button.meridian-session-import__submit");
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("the import panel rendered no submit control");
  }
  return button;
}

/**
 * A progress stream that speaks once and then stays open until the case ends it.
 *
 * The scenario's own stream runs to its terminal frame on its own, which is right for
 * the case above and wrong for this one: what is asserted here is the state BETWEEN
 * the first frame and the last, and a stream that walks itself puts that moment where
 * the runtime decides rather than where the case does.
 */
function heldProgressStream(): {
  readonly handle: { readonly events: AsyncIterable<GrowthImportProgress>; close: () => void };
  readonly end: () => void;
} {
  let end = (): void => undefined;
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  return {
    end: (): void => {
      end();
    },
    handle: {
      events: {
        async *[Symbol.asyncIterator](): AsyncGenerator<GrowthImportProgress> {
          yield { importId: "held-import", turnsSeen: 7, state: "reading" };
          await ended;
        },
      },
      close: (): void => {
        end();
      },
    },
  };
}
