// Putting a provider import from its panel, end to end.
//
// The panel and the model above it are the real modules and the two calls are plain
// stubs. What is asserted is what the form sends, that the subscription opens on the id
// the begin answers with, and that the panel renders the producer's own words at every
// step until the producer stops — with the control shut until then.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProviderImportPanel } from "./ProviderImportPanel.js";
import { useProviderImport, type ProviderImportBeginCall } from "./provider-import-model.js";
import type {
  ImportProgressFrame,
  ImportProgressStream,
  ImportProgressSubscribeCall,
} from "./provider-import.js";
import { settle } from "../../core/settle.test-support.js";

/** The id the stubbed begin answers with, so the subscription can be shown to use it. */
const IMPORT_ID = "provider-import-3";

/** The producer's frames, ending on a terminal one. */
const FRAMES: readonly ImportProgressFrame[] = [
  { importId: IMPORT_ID, turnsSeen: 7, state: "reading the transcript" },
  { importId: IMPORT_ID, turnsSeen: 33, state: "reading the transcript" },
  { importId: IMPORT_ID, turnsSeen: 61, state: "complete" },
];

/**
 * A stream that waits for the case before each frame, and ends after the last.
 *
 * Paced by the case rather than by a clock, so the intermediate reading states are on
 * screen to be asserted at all — a stream that walked itself would batch them into the
 * terminal frame.
 */
function steppedStream(): {
  readonly stream: ImportProgressStream;
  readonly step: () => Promise<void>;
} {
  let release: (() => void) | undefined;
  let isReleased = false;
  async function* frames(): AsyncGenerator<ImportProgressFrame> {
    for (const frame of FRAMES) {
      // A release that arrived before the generator parked is spent here, so the
      // case never depends on which of the two got there first.
      if (!isReleased) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      isReleased = false;
      yield frame;
    }
  }
  return {
    stream: { events: frames(), close: () => undefined },
    step: async () => {
      await act(async () => {
        isReleased = true;
        release?.();
        await settle();
      });
    },
  };
}

function ImportHost(props: {
  readonly begin: ProviderImportBeginCall;
  readonly subscribe: ImportProgressSubscribeCall;
}): React.JSX.Element {
  return <ProviderImportPanel model={useProviderImport(props.begin, props.subscribe)} />;
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

/** The panel's own submit control. */
function submitControl(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector("button.meridian-session-import__submit");
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("the import panel rendered no submit control");
  }
  return button;
}

/** What the progress line says, or an empty string where it is absent. */
function progressText(container: HTMLElement): string {
  return container.querySelector(".meridian-session-import__progress")?.textContent ?? "";
}

describe("importing a provider session", () => {
  it("sends the request, follows the producer to its end, then reopens the form", async () => {
    const beginRequests: unknown[] = [];
    const subscribeRequests: unknown[] = [];
    const { stream, step } = steppedStream();
    const view = render(
      <ImportHost
        begin={async (request) => {
          beginRequests.push(request);
          return await Promise.resolve({ importId: IMPORT_ID });
        }}
        subscribe={async (request) => {
          subscribeRequests.push(request);
          return await Promise.resolve(stream);
        }}
      />,
    );

    fill(view.container, "Provider", "claude");
    fill(view.container, "What to read", "~/.claude/threads/one.jsonl");
    act(() => {
      view.container
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle();

    // The form sends what a person typed, and the subscription opens on the id the
    // begin answered with rather than on anything the form knows.
    expect(beginRequests).toStrictEqual([
      { providerName: "claude", sourceRef: "~/.claude/threads/one.jsonl" },
    ]);
    expect(subscribeRequests).toStrictEqual([{ importId: IMPORT_ID }]);

    // Step-wise through the producer's frames: each one is on screen in its own words
    // while the import is running, and the control stays shut for all of them. A
    // control re-enabled here would let a second submit replace the id and orphan this
    // reading with nothing on screen reporting it.
    for (const frame of FRAMES.slice(0, 2)) {
      await step();
      expect(progressText(view.container)).toContain(String(frame.turnsSeen));
      expect(progressText(view.container)).toContain("Reading");
      expect(submitControl(view.container).disabled).toBe(true);
    }

    // And the moment the producer stops, the form is a form again.
    await step();
    expect(progressText(view.container)).toContain("Ended");
    expect(progressText(view.container)).toContain("complete");
    expect(progressText(view.container)).toContain("61");
    expect(submitControl(view.container).disabled).toBe(false);
  });
});
