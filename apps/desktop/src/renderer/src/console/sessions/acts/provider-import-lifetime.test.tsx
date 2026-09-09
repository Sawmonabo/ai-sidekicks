// How long a provider import lives, which is not how long its panel is on screen.
//
// THE DEFECT, AND WHY NOTHING REPORTED IT. The import panel is one of the acts bar's
// two conditional children, and it held the whole import: the begin act in its own
// subject-scoped cell and the progress drain in its own effect. Switching the
// disclosure to the join form unmounted it mid-import — the cleanup closed the
// progress subscription while the daemon went on reading — and coming back built a
// fresh act with no import id, which is what the one-import-at-a-time guard is
// derived from. So the panel offered a second import over a first one still running,
// and the first one's progress was gone for good. Every part of that is silent.
//
// TWO CLAIMS, AND THEY ARE DIFFERENT CLAIMS. The first is that the import survives its
// panel: the state moved above the condition, so an unmount of the panel costs the
// reading nothing. The second is that the switch closes while a reading is underway —
// `Spec-023 §Console Design (Meridian)` rule 9, disabled with its sentence beside it
// rather than hidden — because this panel is the only place this window reports an
// import. Both are worth having: the guard keeps a person from losing sight of a
// running import, and the lift is what makes the guard a courtesy rather than the
// only thing standing between them and a lost one.
//
// WHICH IS WHY THE FIRST CLAIM IS DRIVEN THROUGH A PROBE. The acts bar no longer
// offers a way to unmount this panel mid-import, so a case that went through the bar
// could not reach the moment under test at all. The probe copies the composition that
// matters — the model above the condition, the panel below it — and both halves of it
// are the real modules. The second claim is asserted through the real bar, where the
// switch is.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProviderImportPanel } from "./ProviderImportPanel.js";
import { SessionActs } from "./SessionActs.js";
import { useProviderImport } from "./provider-import-model.js";
import { openImportDisclosure, QUIET_PREFERENCES } from "./session-acts.test-support.js";
import { BRING_YOUR_HISTORY_SCENARIO } from "../../bridge/scenarios/bring-your-history.js";
import { DrivenGrowthStream } from "../../bridge/growth-port/driven-growth-stream.test-support.js";
import {
  fixtureBridgeWithGrowth,
  growthServing,
} from "../../bridge/fixture/call-plane/bridge.test-support.js";
import { settle } from "../../core/settle.test-support.js";
import type { ConsoleBridge, GrowthImportProgress } from "../../bridge/index.js";

/** The one import every case here starts, named so a remount can be shown to find it. */
const IMPORT_ID = "provider-import-19";

const WHILE_READING: GrowthImportProgress = {
  importId: IMPORT_ID,
  turnsSeen: 12,
  state: "reading the transcript",
};

/** A second frame, so a case can prove the subscription is still LIVE and not merely held. */
const STILL_READING: GrowthImportProgress = {
  importId: IMPORT_ID,
  turnsSeen: 31,
  state: "reading the transcript",
};

/** The sentence the disclosure switch wears while a reading is underway. */
const DISCLOSURE_SENTENCE_FRAGMENT = "This panel is the only place this window reports it";

/**
 * The real fixture bridge, with the import's two calls answered by the case.
 *
 * The begin settles at once and the progress stream is driven frame by frame, which
 * is what puts the moment under test — the middle of a reading — where the case says
 * rather than where the scenario's clock does.
 */
function bridgeReading(stream: DrivenGrowthStream<GrowthImportProgress>): ConsoleBridge {
  return fixtureBridgeWithGrowth(BRING_YOUR_HISTORY_SCENARIO, {
    providerSessionImportBegin: growthServing({ importId: IMPORT_ID }),
    providerSessionImportSubscribe: growthServing(stream),
  });
}

/**
 * The acts bar's own composition, with the panel's mount under the case's control.
 *
 * The growth port is a PROP and the case passes the same one on every render, because
 * that port is what the import is addressed by: a fresh bridge per render would
 * re-mint the act and the case would be watching its own churn rather than a
 * disclosure moving.
 */
function ImportHost(props: {
  readonly bridge: ConsoleBridge;
  readonly isPanelMounted: boolean;
}): React.JSX.Element {
  const providerImport = useProviderImport(props.bridge.growth);
  return <div>{props.isPanelMounted ? <ProviderImportPanel model={providerImport} /> : null}</div>;
}

/**
 * The composition this fix replaced: the model minted INSIDE the conditional child.
 *
 * The one control that makes the case above a claim about PLACEMENT rather than about
 * a stream that happened to stay open. Both compositions use the same real hook and
 * the same real panel and differ in one thing — which side of the condition the model
 * is held on — so a case that passes over the first and fails over this one has
 * isolated the fix to that difference and to nothing else.
 */
function PanelHeldImport(props: { readonly bridge: ConsoleBridge }): React.JSX.Element {
  const providerImport = useProviderImport(props.bridge.growth);
  return <ProviderImportPanel model={providerImport} />;
}

function PanelHeldImportHost(props: {
  readonly bridge: ConsoleBridge;
  readonly isPanelMounted: boolean;
}): React.JSX.Element {
  return <div>{props.isPanelMounted ? <PanelHeldImport bridge={props.bridge} /> : null}</div>;
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

function submit(container: HTMLElement): void {
  const form = container.querySelector("form");
  act(() => {
    form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

/** Fill the panel's two fields and put the import. */
async function startAnImport(container: HTMLElement): Promise<void> {
  fill(container, "Provider", "claude");
  fill(container, "What to read", "~/.claude/threads/one.jsonl");
  submit(container);
  await settle();
}

/** The panel's own submit control, or `undefined` while no panel is mounted. */
function submitControl(container: HTMLElement): HTMLButtonElement | undefined {
  const button = container.querySelector("button.meridian-session-import__submit");
  return button instanceof HTMLButtonElement ? button : undefined;
}

/** The acts bar's disclosure switch, which is what a running import closes. */
function joinDisclosure(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(".meridian-session-acts__secondary");
  if (button === null) {
    throw new Error("the acts bar rendered no join disclosure");
  }
  return button;
}

describe("an import whose panel goes away", () => {
  it("keeps reading, and comes back to the same import rather than a fresh one", async () => {
    const stream = new DrivenGrowthStream<GrowthImportProgress>();
    const bridge = bridgeReading(stream);
    const view = render(<ImportHost bridge={bridge} isPanelMounted />);

    await startAnImport(view.container);
    await act(async () => {
      stream.emit(WHILE_READING);
      await settle();
    });
    expect(view.container.textContent).toContain("12");

    // The disclosure moving, as the panel experiences it.
    view.rerender(<ImportHost bridge={bridge} isPanelMounted={false} />);
    await settle();
    expect(submitControl(view.container)).toBeUndefined();
    // A frame that arrives while nobody is looking. The subscription is still open —
    // it was the panel's own cleanup that used to close it — so this one lands.
    await act(async () => {
      stream.emit(STILL_READING);
      await settle();
    });

    view.rerender(<ImportHost bridge={bridge} isPanelMounted />);
    await settle();

    // The same import, still being read, reporting what happened while the panel was
    // away rather than starting again from nothing — and the guard is still derived
    // from an id that still exists, so a second import is refused.
    expect(view.container.textContent).toContain("31");
    expect(submitControl(view.container)?.disabled).toBe(true);
    expect(view.container.textContent).toContain("The last import is still being read.");
    // And nobody let go of the subscription on the way past.
    expect(stream.closeCount).toBe(0);
  });

  it("negative control: an import that ENDED leaves the form a form again", async () => {
    // Without this the case above would pass over a panel that reported "still being
    // read" for every import it had ever seen — the same control stuck in the other
    // direction, and just as wrong.
    const stream = new DrivenGrowthStream<GrowthImportProgress>();
    const bridge = bridgeReading(stream);
    const view = render(<ImportHost bridge={bridge} isPanelMounted />);

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
    expect(submitControl(view.container)?.disabled).toBe(false);
  });

  it("negative control: minted inside the panel, the same import does not survive it", async () => {
    // The defect, driven through the real hook and the real panel with one thing
    // changed — the side of the condition the model is held on. Without this the case
    // above would pass over a stream that merely happened to stay open, and the fix's
    // claim would rest on nothing.
    const stream = new DrivenGrowthStream<GrowthImportProgress>();
    const bridge = bridgeReading(stream);
    const view = render(<PanelHeldImportHost bridge={bridge} isPanelMounted />);

    await startAnImport(view.container);
    await act(async () => {
      stream.emit(WHILE_READING);
      await settle();
    });
    expect(view.container.textContent).toContain("12");

    view.rerender(<PanelHeldImportHost bridge={bridge} isPanelMounted={false} />);
    await settle();
    view.rerender(<PanelHeldImportHost bridge={bridge} isPanelMounted />);
    await settle();

    // A fresh act with no import id: the guard the panel derives from that id is
    // gone, so a second import is offered over the first — and the first reading's
    // subscription was closed on the way out, which is what leaves nothing to report.
    expect(stream.closeCount).toBe(1);
    expect(view.container.textContent).not.toContain("The last import is still being read.");
    expect(view.container.querySelector(".meridian-session-import__progress")).toBeNull();
  });
});

describe("the disclosure switch while an import is being read", () => {
  it("is offered and refused with the reason, rather than taken away", async () => {
    const stream = new DrivenGrowthStream<GrowthImportProgress>();
    const { container } = render(
      <SessionActs
        bridge={bridgeReading(stream)}
        preferences={QUIET_PREFERENCES}
        onStart={() => undefined}
        onJoined={() => undefined}
      />,
    );
    openImportDisclosure(container);

    await startAnImport(container);
    await act(async () => {
      stream.emit(WHILE_READING);
      await settle();
    });

    // Rule 9: the control stays on screen and says why it will not move.
    expect(joinDisclosure(container).disabled).toBe(true);
    expect(container.textContent).toContain(DISCLOSURE_SENTENCE_FRAGMENT);
  });

  it("negative control: the switch is open while no import is running", async () => {
    // Without this the case above would pass over a bar that had simply disabled its
    // disclosure, which is a destination with one act.
    const stream = new DrivenGrowthStream<GrowthImportProgress>();
    const { container } = render(
      <SessionActs
        bridge={bridgeReading(stream)}
        preferences={QUIET_PREFERENCES}
        onStart={() => undefined}
        onJoined={() => undefined}
      />,
    );
    openImportDisclosure(container);
    await settle();

    expect(joinDisclosure(container).disabled).toBe(false);
    expect(container.textContent).not.toContain(DISCLOSURE_SENTENCE_FRAGMENT);
  });
});
