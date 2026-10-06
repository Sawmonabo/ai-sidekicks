// How long a provider import lives, which is not how long its panel is on screen.
//
// A panel that held the whole import lost it when it unmounted mid-import: the cleanup closed
// the subscription while the daemon kept reading, and the fresh act that came back read as
// nothing underway, so a second import was offered over the first. The claim is that the
// import survives its panel because the model lives above the condition. The host copies that
// composition with the real model and panel; the calls are stubs.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type {
  ProviderImportId,
  ProviderImportProgress,
} from "@ai-sidekicks/contracts/provider/import";

import { ProviderImportPanel } from "../panel/ProviderImportPanel.js";
import { useProviderImport, type ProviderImportBeginCall } from "./useProviderImport.js";
import type { ImportProgressStream, ImportProgressSubscribeCall } from "../progress.js";
import { settle } from "#test/helpers/settle.js";
import { chooseProvider } from "../panel/ProviderImportPanel.test-support.js";

/** The one import every case here starts, named so a remount can be shown to find it. */
const IMPORT_ID = "provider-import-19" as ProviderImportId;

const WHILE_READING: ProviderImportProgress = {
  kind: "progress",
  provider: "claude",
  importId: IMPORT_ID,
  read: 12,
};

/** A second message, so a case can prove the subscription is still live and not merely held. */
const STILL_READING: ProviderImportProgress = { ...WHILE_READING, read: 31 };

/**
 * A progress stream a case drives by hand, and whose closes it counts.
 *
 * The close is counted, not flagged, so a drain that closed twice (a double release on the
 * live wire) is caught.
 */
class DrivenProgressStream implements ImportProgressStream {
  #pending: ProviderImportProgress | undefined;
  #wake: (() => void) | undefined;
  #isClosed = false;
  #closeCount = 0;

  public get events(): AsyncIterable<ProviderImportProgress> {
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

  /** Deliver one message to whatever is draining. */
  public emit(message: ProviderImportProgress): void {
    this.#pending = message;
    this.#wake?.();
    this.#wake = undefined;
  }

  async *#iterate(): AsyncGenerator<ProviderImportProgress> {
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
 * The begin settles at once and the stream is driven frame by frame, which puts the middle
 * of a reading where the case says.
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
 * The calls are props and the case passes the same ones every render, because the begin call
 * is what the import is addressed by; fresh calls would re-mint the act.
 */
function ImportHarness(props: {
  readonly calls: ImportCalls;
  readonly isPanelMounted: boolean;
}): React.JSX.Element {
  const providerImport = useProviderImport(props.calls.begin, props.calls.subscribe);
  return <div>{props.isPanelMounted ? <ProviderImportPanel model={providerImport} /> : null}</div>;
}

function submit(container: HTMLElement): void {
  const form = container.querySelector("form");
  act(() => {
    form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

/** Choose the provider and put the import. */
async function startAnImport(container: HTMLElement): Promise<void> {
  chooseProvider(container, "claude");
  submit(container);
  await settle();
}

/** The panel's own submit control, or `undefined` while no panel is mounted. */
function submitControl(container: HTMLElement): HTMLButtonElement | undefined {
  const button = container.querySelector("button.meridian-provider-import__submit");
  return button instanceof HTMLButtonElement ? button : undefined;
}

describe("an import whose panel goes away", () => {
  it("keeps reading, and comes back to the same import rather than a fresh one", async () => {
    const stream = new DrivenProgressStream();
    const calls = callsReading(stream);
    const view = render(<ImportHarness calls={calls} isPanelMounted />);

    await startAnImport(view.container);
    await act(async () => {
      stream.emit(WHILE_READING);
      await settle();
    });
    expect(view.container.textContent).toContain("12");

    // The disclosure moving, as the panel experiences it.
    view.rerender(<ImportHarness calls={calls} isPanelMounted={false} />);
    await settle();
    expect(submitControl(view.container)).toBeUndefined();
    // A frame that arrives while nobody is looking; the subscription is still open, so it
    // lands.
    await act(async () => {
      stream.emit(STILL_READING);
      await settle();
    });

    view.rerender(<ImportHarness calls={calls} isPanelMounted />);
    await settle();

    // The same import, still being read and reporting what happened while the panel was
    // away; the control is still shut because the act still exists.
    expect(view.container.textContent).toContain("31");
    expect(submitControl(view.container)?.disabled).toBe(true);
    expect(view.container.textContent).toContain("The last import is still being read.");
    // And nobody let go of the subscription on the way past.
    expect(stream.closeCount).toBe(0);
  });
});
