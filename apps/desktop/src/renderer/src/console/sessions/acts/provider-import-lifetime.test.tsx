// How long a provider import lives, which is not how long its panel is on screen.
//
// THE DEFECT, AND WHY NOTHING REPORTED IT. An import panel that held the whole import —
// the begin act in its own subject-scoped cell and the progress drain in its own
// effect — lost it whenever the panel unmounted mid-import: the cleanup closed the
// progress subscription while the daemon went on reading, and coming back built a fresh
// act with no import id, which is what the one-import-at-a-time guard is derived from.
// So the panel offered a second import over a first one still running, and the first
// one's progress was gone for good. Every part of that is silent.
//
// THE CLAIM is that the import survives its panel: the state lives above the condition,
// so an unmount of the panel costs the reading nothing. It is driven through a host that
// copies the composition that matters — the model above the condition, the panel below
// it — and both halves of it are the real modules. The calls are plain stubs.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProviderImportPanel } from "@renderer/features/settings/pages/providers/import/ProviderImportPanel.js";
import {
  useProviderImport,
  type ProviderImportBeginCall,
} from "@renderer/features/settings/pages/providers/import/useProviderImport.js";
import type {
  ImportProgressFrame,
  ImportProgressStream,
  ImportProgressSubscribeCall,
} from "./provider-import.js";
import { settle } from "@test/helpers/settle.js";

/** The one import every case here starts, named so a remount can be shown to find it. */
const IMPORT_ID = "provider-import-19";

const WHILE_READING: ImportProgressFrame = {
  importId: IMPORT_ID,
  turnsSeen: 12,
  state: "reading the transcript",
};

/** A second frame, so a case can prove the subscription is still LIVE and not merely held. */
const STILL_READING: ImportProgressFrame = {
  importId: IMPORT_ID,
  turnsSeen: 31,
  state: "reading the transcript",
};

/**
 * A progress stream a case drives by hand, and whose closes it counts.
 *
 * The close is counted rather than flagged: "closed at least once" cannot tell a drain
 * that let go of its handle from one that let go of it twice, and the second is a
 * double release on the live wire.
 */
class DrivenProgressStream implements ImportProgressStream {
  #pending: ImportProgressFrame | undefined;
  #wake: (() => void) | undefined;
  #isClosed = false;
  #closeCount = 0;

  public get events(): AsyncIterable<ImportProgressFrame> {
    return this.#iterate();
  }

  /** How many times the drain closed this stream. */
  public get closeCount(): number {
    return this.#closeCount;
  }

  public close(): void {
    this.#closeCount += 1;
    this.#isClosed = true;
    this.#wake?.();
    this.#wake = undefined;
  }

  /** Deliver one frame to whatever is draining. */
  public emit(frame: ImportProgressFrame): void {
    this.#pending = frame;
    this.#wake?.();
    this.#wake = undefined;
  }

  async *#iterate(): AsyncGenerator<ImportProgressFrame> {
    while (!this.#isClosed) {
      const pending = this.#pending;
      if (pending !== undefined) {
        this.#pending = undefined;
        yield pending;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }
}

interface ImportCalls {
  readonly begin: ProviderImportBeginCall;
  readonly subscribe: ImportProgressSubscribeCall;
}

/**
 * The import's two calls, answered by the case.
 *
 * The begin settles at once and the progress stream is driven frame by frame, which
 * puts the moment under test — the middle of a reading — where the case says.
 */
function callsReading(stream: DrivenProgressStream): ImportCalls {
  return {
    begin: async () => await Promise.resolve({ importId: IMPORT_ID }),
    subscribe: async () => await Promise.resolve(stream),
  };
}

/**
 * The composition the model exists for: the model above the condition, the panel below it.
 *
 * The calls are PROPS and the case passes the same ones on every render, because the
 * begin call is what the import is addressed by: fresh calls per render would re-mint
 * the act and the case would be watching its own churn rather than a disclosure moving.
 */
function ImportHost(props: {
  readonly calls: ImportCalls;
  readonly isPanelMounted: boolean;
}): React.JSX.Element {
  const providerImport = useProviderImport(props.calls.begin, props.calls.subscribe);
  return <div>{props.isPanelMounted ? <ProviderImportPanel model={providerImport} /> : null}</div>;
}

/**
 * The composition the model replaced: the model minted INSIDE the conditional child.
 *
 * The one control that makes the case above a claim about PLACEMENT rather than about
 * a stream that happened to stay open. Both compositions use the same real hook and
 * the same real panel and differ in one thing — which side of the condition the model
 * is held on.
 */
function PanelHeldImport(props: { readonly calls: ImportCalls }): React.JSX.Element {
  const providerImport = useProviderImport(props.calls.begin, props.calls.subscribe);
  return <ProviderImportPanel model={providerImport} />;
}

function PanelHeldImportHost(props: {
  readonly calls: ImportCalls;
  readonly isPanelMounted: boolean;
}): React.JSX.Element {
  return <div>{props.isPanelMounted ? <PanelHeldImport calls={props.calls} /> : null}</div>;
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

describe("an import whose panel goes away", () => {
  it("keeps reading, and comes back to the same import rather than a fresh one", async () => {
    const stream = new DrivenProgressStream();
    const calls = callsReading(stream);
    const view = render(<ImportHost calls={calls} isPanelMounted />);

    await startAnImport(view.container);
    await act(async () => {
      stream.emit(WHILE_READING);
      await settle();
    });
    expect(view.container.textContent).toContain("12");

    // The disclosure moving, as the panel experiences it.
    view.rerender(<ImportHost calls={calls} isPanelMounted={false} />);
    await settle();
    expect(submitControl(view.container)).toBeUndefined();
    // A frame that arrives while nobody is looking. The subscription is still open —
    // it was the panel's own cleanup that used to close it — so this one lands.
    await act(async () => {
      stream.emit(STILL_READING);
      await settle();
    });

    view.rerender(<ImportHost calls={calls} isPanelMounted />);
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
    const stream = new DrivenProgressStream();
    const view = render(<ImportHost calls={callsReading(stream)} isPanelMounted />);

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
    const stream = new DrivenProgressStream();
    const calls = callsReading(stream);
    const view = render(<PanelHeldImportHost calls={calls} isPanelMounted />);

    await startAnImport(view.container);
    await act(async () => {
      stream.emit(WHILE_READING);
      await settle();
    });
    expect(view.container.textContent).toContain("12");

    view.rerender(<PanelHeldImportHost calls={calls} isPanelMounted={false} />);
    await settle();
    view.rerender(<PanelHeldImportHost calls={calls} isPanelMounted />);
    await settle();

    // A fresh act with no import id: the guard the panel derives from that id is
    // gone, so a second import is offered over the first — and the first reading's
    // subscription was closed on the way out, which is what leaves nothing to report.
    expect(stream.closeCount).toBe(1);
    expect(view.container.textContent).not.toContain("The last import is still being read.");
    expect(view.container.querySelector(".meridian-session-import__progress")).toBeNull();
  });
});
