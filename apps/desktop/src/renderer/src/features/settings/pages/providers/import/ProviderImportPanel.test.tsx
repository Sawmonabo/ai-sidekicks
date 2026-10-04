// Putting a provider import from its panel, end to end.
//
// The panel and the model above it are the real modules; the two calls are stubs. Asserts
// what the form sends, that the stream opens on the named provider, and that the panel shows
// the service's own words at every step, with the control shut until the started import
// settles.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type {
  ProviderImportId,
  ProviderImportProgress,
} from "@ai-sidekicks/contracts/provider-import";
import { ProviderImportPanel } from "./ProviderImportPanel.js";
import { useProviderImport, type ProviderImportBeginCall } from "./useProviderImport.js";
import type { ImportProgressStream, ImportProgressSubscribeCall } from "./import-progress.js";
import { chooseProvider } from "./provider-import.test-support.js";
import { settle } from "@test/helpers/settle.js";

/** The id the stubbed start answers with. */
const IMPORT_ID = "provider-import-3" as ProviderImportId;

/** How the provider's previous import ended: the first message a stream sends. */
const PREVIOUS_OUTCOME: ProviderImportProgress = {
  kind: "settled",
  provider: "claude",
  importId: "provider-import-2" as ProviderImportId,
  settlement: { outcome: "nothingNew", alreadyHere: 4, unreadableFiles: [] },
};

/** The service's messages for the import this case starts, ending on its outcome. */
const MESSAGES: readonly ProviderImportProgress[] = [
  PREVIOUS_OUTCOME,
  { kind: "progress", provider: "claude", importId: IMPORT_ID, read: 7 },
  { kind: "progress", provider: "claude", importId: IMPORT_ID, read: 33 },
  {
    kind: "settled",
    provider: "claude",
    importId: IMPORT_ID,
    settlement: {
      outcome: "finished",
      imported: 58,
      total: 61,
      alreadyHere: 4,
      failures: [{ source: "one.jsonl", reason: "truncated" }],
      unreadableFiles: [],
      attachedProjects: ["web"],
    },
  },
];

/**
 * A stream that waits for the case before each message.
 *
 * Paced by the case, not a clock, so the intermediate states are on screen to be asserted;
 * a stream that walked itself would batch them into the last.
 */
function steppedStream(): {
  readonly stream: ImportProgressStream;
  readonly step: () => Promise<void>;
} {
  let release: (() => void) | undefined;
  let isReleased = false;
  async function* messages(): AsyncGenerator<ProviderImportProgress> {
    for (const message of MESSAGES) {
      // A release that arrived before the generator parked is spent here, so order does not matter.
      if (!isReleased) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      isReleased = false;
      yield message;
    }
  }
  return {
    stream: { events: messages(), close: () => undefined },
    step: async () => {
      await act(async () => {
        isReleased = true;
        release?.();
        await settle();
      });
    },
  };
}

function ImportHarness(props: {
  readonly begin: ProviderImportBeginCall;
  readonly subscribe: ImportProgressSubscribeCall;
}): React.JSX.Element {
  return <ProviderImportPanel model={useProviderImport(props.begin, props.subscribe)} />;
}

/** The panel's own submit control. */
function submitControl(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector("button.meridian-provider-import__submit");
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("the import panel rendered no submit control");
  }
  return button;
}

/** What the progress line says, or an empty string where it is absent. */
function progressText(container: HTMLElement): string {
  return container.querySelector(".meridian-provider-import__progress")?.textContent ?? "";
}

describe("importing a provider's conversations", () => {
  it("sends the provider, follows its import to the end, then reopens the form", async () => {
    const beginRequests: unknown[] = [];
    const subscribeRequests: unknown[] = [];
    const { stream, step } = steppedStream();
    const view = render(
      <ImportHarness
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

    expect(submitControl(view.container).disabled).toBe(true);
    chooseProvider(view.container, "claude");
    act(() => {
      view.container
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle();

    expect(beginRequests).toStrictEqual([{ provider: "claude" }]);
    expect(subscribeRequests).toStrictEqual([{ provider: "claude" }]);

    // The stream's first message is the last import's outcome. It is shown, and it
    // does not reopen the form: the import this panel started has not settled.
    await step();
    expect(progressText(view.container)).toContain("found nothing new");
    expect(submitControl(view.container).disabled).toBe(true);

    for (const read of [7, 33]) {
      await step();
      expect(progressText(view.container)).toContain(`Reading — ${String(read)} conversations`);
      expect(submitControl(view.container).disabled).toBe(true);
    }

    // And the moment the import it started settles, the form is a form again.
    await step();
    expect(progressText(view.container)).toBe(
      "The last import brought in 58 of 61 conversations; 4 already here. 1 conversation could not be imported. Attached 1 project.",
    );
    expect(submitControl(view.container).disabled).toBe(false);
  });
});
