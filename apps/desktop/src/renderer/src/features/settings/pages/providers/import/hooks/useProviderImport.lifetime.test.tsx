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
import { useProviderImport, type ProviderImportCalls } from "./useProviderImport.js";
import { DrivenProgressStream } from "../progress.test-support.js";
import { settle } from "#test/helpers/settle.js";

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
 * The import's three calls, answered by the case.
 *
 * The begin settles at once and the stream is driven frame by frame, which puts the middle
 * of a reading where the case says.
 */
function callsReading(stream: DrivenProgressStream): ProviderImportCalls {
  return {
    begin: async () => await Promise.resolve({ importId: IMPORT_ID }),
    subscribe: async () => await Promise.resolve(stream),
    stop: async () => {
      await Promise.resolve();
    },
  };
}

/**
 * The composition the model exists for: the model above the condition, the panel below it.
 *
 * The calls are props and the case passes the same ones every render, because the calls are
 * what the import is addressed by; fresh calls would re-mint the act.
 */
function ImportHarness(props: {
  readonly calls: ProviderImportCalls;
  readonly isPanelMounted: boolean;
}): React.JSX.Element {
  const providerImport = useProviderImport("claude", props.calls);
  return <div>{props.isPanelMounted ? <ProviderImportPanel model={providerImport} /> : null}</div>;
}

/** The panel's import action, or `undefined` while no panel is mounted. */
function importAction(container: HTMLElement): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Import sessions from Claude Code",
  );
}

/** Press the import action and let the start settle. */
async function startAnImport(container: HTMLElement): Promise<void> {
  act(() => {
    importAction(container)?.click();
  });
  await settle();
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
    expect(view.container.textContent).toContain("Importing from Claude Code… 12 read.");

    // The disclosure moving, as the panel experiences it.
    view.rerender(<ImportHarness calls={calls} isPanelMounted={false} />);
    await settle();
    expect(importAction(view.container)).toBeUndefined();
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
    expect(view.container.textContent).toContain("Importing from Claude Code… 31 read.");
    expect(importAction(view.container)?.disabled).toBe(true);
    // And nobody let go of the subscription on the way past.
    expect(stream.closeCount).toBe(0);
  });
});
