// One import at a time, held across a subscription that STOPPED rather than ended.
//
// THE DEFECT. `providerSessionImportBegin` had already settled — the daemon minted an
// id and started reading — when the progress subscription refused or its iterator
// rejected. The reading's `refused` arm was read as "not underway", which re-enabled
// the submit control and the disclosure switch: a second import could begin, the id
// the guard is derived from was replaced, and the first import went on being read
// with nothing anywhere reporting it. Delivery stopping is this window losing sight
// of an import; it is not the import ending, and the two must not settle the same way.
//
// SO THE GUARD OUTLIVES THE SUBSCRIPTION AND THE WAY OUT IS A RE-ATTACH. The control
// stays shut with its own sentence beside it — never "still being read", which would
// claim frames nobody is sending — and the refusal carries the one act that can end
// the standoff honestly: subscribe to the SAME id again. A terminal frame is what
// opens the guard, which is the producer's own answer rather than this window's.
//
// AND THE RELEASE ARM IS DRIVEN TOO, because a guard that never opens is the same
// defect pointing the other way. Two cases carry it: a producer that reached its own
// end, and a refusal whose registered remedy says the request it names is finished —
// the console's one reading of that question, shared with the approvals surface.
//
// EVERY CASE DRIVES THE REAL MODEL ABOVE THE REAL PANEL, which is the composition
// `SessionActs` ships: the import is held above the disclosure and the panel is a view
// over it, so a case asserts on the control a person actually presses.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProviderImportPanel } from "./ProviderImportPanel.js";
import { useProviderImport } from "./provider-import-model.js";
import { BRING_YOUR_HISTORY_SCENARIO } from "../../bridge/scenarios/bring-your-history.js";
import { DrivenGrowthStream } from "../../bridge/growth-port/driven-growth-stream.test-support.js";
import {
  fixtureBridgeWithGrowth,
  growthAnswering,
  growthServing,
} from "../../bridge/fixture/fixture-bridge.test-support.js";
import { ConsoleRefusalError, refuse } from "../../core/index.js";
import { settle } from "../../core/settle.test-support.js";
import type { ConsoleBridge, GrowthImportProgress } from "../../bridge/index.js";
// Deep, because the stream contract is not on the bridge door and may not be put there:
// a door line exists for a PRODUCTION reader, and this shape has none outside the family.
// Test files are excluded from the layering graph for exactly this case.
import type { GrowthStream } from "../../bridge/growth-port/growth-outcome.js";

/** The one import every case here starts, named so a re-attach can be shown to find it. */
const IMPORT_ID = "provider-import-41";

const WHILE_READING: GrowthImportProgress = {
  importId: IMPORT_ID,
  turnsSeen: 12,
  state: "reading the transcript",
};

/** The sentence the panel wears while delivery has stopped and the guard is armed. */
const LOST_DELIVERY_SENTENCE = "The last import stopped reporting";

/** The sentence the panel wears while frames are actually arriving. */
const STILL_READING_SENTENCE = "The last import is still being read.";

/** What the re-attach control says. Read by text, the way a person finds it. */
const RETRY_LABEL = "Watch this import again";

/**
 * The acts bar's composition, with the import held above the panel.
 *
 * The growth port is a PROP and every render passes the same one, because that port
 * is what the import is addressed by: a fresh bridge per render would re-mint the act
 * and the case would be watching its own churn.
 */
function ImportHost(props: { readonly bridge: ConsoleBridge }): React.JSX.Element {
  const providerImport = useProviderImport(props.bridge.growth);
  return <ProviderImportPanel model={providerImport} />;
}

/**
 * A bridge whose begin settles at once and whose subscribe is the case's to answer.
 *
 * `growthAnswering` and not a value decided up front, because what every case here is
 * about is the SECOND subscribe differing from the first — a fixture that closed over
 * one answer could not express a re-attach at all.
 */
function bridgeSubscribing(
  answerSubscribe: () => Promise<GrowthStream<GrowthImportProgress>>,
): ConsoleBridge {
  return fixtureBridgeWithGrowth(BRING_YOUR_HISTORY_SCENARIO, {
    providerSessionImportBegin: growthServing({ importId: IMPORT_ID }),
    providerSessionImportSubscribe: growthAnswering(answerSubscribe),
  });
}

/** Type into one of the panel's fields, the way a person does. */
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

/** Fill the panel's two fields and put the import. */
async function startAnImport(container: HTMLElement): Promise<void> {
  fill(container, "Provider", "claude");
  fill(container, "What to read", "~/.claude/threads/one.jsonl");
  await act(async () => {
    container
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
  });
}

/** The panel's own submit control. */
function submitControl(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector("button.meridian-session-import__submit");
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("the panel rendered no submit control");
  }
  return button;
}

/** The re-attach control, or `undefined` where the panel is offering none. */
function retryControl(container: HTMLElement): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find(
    (control) => control.textContent === RETRY_LABEL,
  );
}

describe("an import whose progress subscription refuses after the begin settled", () => {
  it("keeps the submit shut, offers a re-attach, and opens on the producer's own end", async () => {
    // The pin, end to end. The first subscribe refuses outright — the daemon has the
    // import and this window cannot watch it — and the second, the one the re-attach
    // puts, serves a live stream over the SAME id.
    const reattached = new DrivenGrowthStream<GrowthImportProgress>();
    const subscribeRequests: unknown[] = [];
    let subscribesSeen = 0;
    const bridge = fixtureBridgeWithGrowth(BRING_YOUR_HISTORY_SCENARIO, {
      providerSessionImportBegin: growthServing({ importId: IMPORT_ID }),
      providerSessionImportSubscribe: growthAnswering<GrowthStream<GrowthImportProgress>>(
        async (request) => {
          subscribeRequests.push(request);
          subscribesSeen += 1;
          if (subscribesSeen === 1) {
            throw new ConsoleRefusalError(
              refuse("preload", "bridge-torn-down", "The window's bridge was replaced mid-read."),
            );
          }
          return await Promise.resolve(reattached);
        },
      ),
    });
    const view = render(<ImportHost bridge={bridge} />);

    await startAnImport(view.container);
    await settle();

    // The daemon has an import and this window is no longer being told about it, so
    // the control that would start a SECOND one stays shut and says which fact it is
    // on: never "still being read", which claims frames nobody is sending.
    expect(submitControl(view.container).disabled).toBe(true);
    expect(view.container.textContent).toContain(LOST_DELIVERY_SENTENCE);
    expect(view.container.textContent).not.toContain(STILL_READING_SENTENCE);
    expect(submitControl(view.container).textContent).toBe("Import");

    // And the way out is offered rather than left to a person to invent.
    const retry = retryControl(view.container);
    expect(retry).toBeDefined();

    await act(async () => {
      retry?.click();
      await settle();
    });
    await act(async () => {
      reattached.emit(WHILE_READING);
      await settle();
    });

    // The re-attach went back to the SAME import rather than through the begin call,
    // which would have started a second one — the thing the guard exists to prevent.
    expect(subscribeRequests).toStrictEqual([{ importId: IMPORT_ID }, { importId: IMPORT_ID }]);
    expect(view.container.textContent).toContain("12");
    expect(view.container.textContent).toContain(STILL_READING_SENTENCE);

    // And the guard opens on the producer's own terminal and on nothing this window
    // decided for itself.
    await act(async () => {
      reattached.close();
      await settle();
    });
    expect(submitControl(view.container).disabled).toBe(false);
    expect(retryControl(view.container)).toBeUndefined();
  });

  it("holds the same way when the iterator rejects part-way through a reading", async () => {
    // The other route to the refused arm: the subscription opened, frames arrived,
    // and delivery then stopped. The daemon is in exactly the same place — reading an
    // import this window can no longer see — so the guard answers identically.
    const stream = new DrivenGrowthStream<GrowthImportProgress>();
    const view = render(
      <ImportHost bridge={bridgeSubscribing(async () => await Promise.resolve(stream))} />,
    );

    await startAnImport(view.container);
    await act(async () => {
      stream.emit(WHILE_READING);
      await settle();
    });
    expect(submitControl(view.container).disabled).toBe(true);

    await act(async () => {
      stream.fail(new Error("the import's progress subscription was torn down"));
      await settle();
    });

    expect(submitControl(view.container).disabled).toBe(true);
    expect(view.container.textContent).toContain(LOST_DELIVERY_SENTENCE);
    expect(retryControl(view.container)).toBeDefined();
    // The handle is let go of on the way out, so the re-attach opens a subscription
    // rather than a second reader over one nobody closed.
    expect(stream.closeCount).toBe(1);
  });

  it("negative control: a producer that ENDED leaves the form a form again", async () => {
    // Without this every case above would pass over a guard that never opens, which
    // is the same defect pointing the other way — a panel that refuses every import
    // after the first one it ever saw.
    const stream = new DrivenGrowthStream<GrowthImportProgress>();
    const view = render(
      <ImportHost bridge={bridgeSubscribing(async () => await Promise.resolve(stream))} />,
    );

    await startAnImport(view.container);
    await act(async () => {
      stream.emit(WHILE_READING);
      await settle();
    });
    await act(async () => {
      stream.close();
      await settle();
    });

    expect(view.container.textContent).toContain("Ended");
    expect(submitControl(view.container).disabled).toBe(false);
    expect(retryControl(view.container)).toBeUndefined();
  });

  it("negative control: a refusal that says the request is finished opens the guard", async () => {
    // The second release arm, and it is not dead code. `session.not_found` is a code
    // the corpus registers and the shared remedy table marks settled — the session
    // this import belonged to is gone from this node — so there is nothing left to
    // re-attach to and nothing for the guard to protect. Without this case the arm
    // would be a branch no test ever entered.
    const view = render(
      <ImportHost
        bridge={bridgeSubscribing(async () => {
          throw new ConsoleRefusalError(
            refuse("daemon", "session.not_found", "This session is gone from this node."),
          );
        })}
      />,
    );

    await startAnImport(view.container);
    await settle();

    expect(view.container.textContent).toContain("session.not_found");
    expect(submitControl(view.container).disabled).toBe(false);
    expect(retryControl(view.container)).toBeUndefined();
  });
});
