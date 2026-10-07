// One provider's session import from its panel, end to end.
//
// The panel and the model above it are the real modules; the three calls are stubs. Asserts the
// stream opens on the section's provider before anything is pressed, what the action and `Stop`
// send, and that the one progress row says how the import stands in the service's own counts.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type {
  ProviderImportId,
  ProviderImportOutcome,
  ProviderImportProgress,
} from "@ai-sidekicks/contracts/provider/import";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import { ProviderImportPanel } from "./ProviderImportPanel.js";
import { useProviderImport, type ProviderImportCalls } from "../hooks/useProviderImport.js";
import { DrivenProgressStream } from "../progress.test-support.js";
import { settle } from "#test/helpers/settle.js";
import { liveRegionText } from "#test/helpers/live-region.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";

/** The id the stubbed start answers with. */
const IMPORT_ID = "provider-import-3" as ProviderImportId;

/** What each call received, in order. */
interface SentRequests {
  readonly begin: unknown[];
  readonly subscribe: unknown[];
  readonly stop: unknown[];
}

/** The three calls over one driven stream, each recording what it was sent. */
function recordingCalls(stream: DrivenProgressStream): {
  readonly calls: ProviderImportCalls;
  readonly sent: SentRequests;
} {
  const sent: SentRequests = { begin: [], subscribe: [], stop: [] };
  return {
    sent,
    calls: {
      begin: async (request) => {
        sent.begin.push(request);
        return await Promise.resolve({ importId: IMPORT_ID });
      },
      subscribe: async (request) => {
        sent.subscribe.push(request);
        return await Promise.resolve(stream);
      },
      stop: async (request) => {
        sent.stop.push(request);
        await Promise.resolve();
      },
    },
  };
}

function ImportHarness(props: {
  readonly provider: ProviderName;
  readonly calls: ProviderImportCalls;
}): React.JSX.Element {
  return <ProviderImportPanel model={useProviderImport(props.provider, props.calls)} />;
}

/** Mount one provider's panel and let its stream open. */
async function renderPanel(
  provider: ProviderName,
): Promise<{ readonly stream: DrivenProgressStream; readonly sent: SentRequests }> {
  const stream = new DrivenProgressStream();
  const { calls, sent } = recordingCalls(stream);
  render(<ImportHarness provider={provider} calls={calls} />, { wrapper: LiveAnnouncerProvider });
  await settle();
  return { stream, sent };
}

async function emit(stream: DrivenProgressStream, message: ProviderImportProgress): Promise<void> {
  stream.emit(message);
  await settle();
}

function settledMessage(
  provider: ProviderName,
  settlement: ProviderImportOutcome,
): ProviderImportProgress {
  return { kind: "settled", provider, importId: IMPORT_ID, settlement };
}

function importAction(label: string): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>("button", { name: label });
}

/** What the one progress row says: the panel's last part, under its head. */
function rowText(): string {
  const row = document.querySelector(".meridian-provider-import")?.lastElementChild;
  if (row === null || row === undefined) {
    throw new Error("the import panel drew no progress row");
  }
  return row.textContent;
}

/** What one lane of the window's announcer is saying. */
function announced(politeness: "polite" | "assertive"): string {
  return liveRegionText(document.body, politeness);
}

describe("one provider's import", () => {
  it("opens the provider's stream before anything is pressed, and draws its last outcome", async () => {
    const { stream, sent } = await renderPanel("codex");
    expect(sent.subscribe).toStrictEqual([{ provider: "codex" }]);
    expect(sent.begin).toStrictEqual([]);

    await emit(
      stream,
      settledMessage("codex", { outcome: "nothingNew", alreadyHere: 4, unreadableFiles: [] }),
    );
    expect(rowText()).toBe("Nothing new to import from Codex · 4 already here.");
    expect(announced("polite")).toBe("Nothing new to import from Codex · 4 already here.");
    // History is not a running import: the action stays offered.
    expect(importAction("Import sessions from Codex").disabled).toBe(false);
  });

  it("starts on the press, counts what it reads, and stops on Stop with the running import", async () => {
    const { stream, sent } = await renderPanel("claude");
    // Negative control: nothing is running, so there is nothing to stop.
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();

    act(() => {
      importAction("Import sessions from Claude Code").click();
    });
    await settle();
    expect(sent.begin).toStrictEqual([{ provider: "claude" }]);
    expect(importAction("Import sessions from Claude Code").disabled).toBe(true);

    await emit(stream, { kind: "progress", provider: "claude", importId: IMPORT_ID, read: 128 });
    expect(rowText()).toContain("Importing from Claude Code… 128 read.");
    // The bar measures nothing: the stream sent no total to measure against.
    expect(screen.getByRole("progressbar").hasAttribute("value")).toBe(false);

    act(() => {
      screen.getByRole("button", { name: "Stop" }).click();
    });
    await settle();
    expect(sent.stop).toStrictEqual([{ importId: IMPORT_ID }]);

    await emit(stream, settledMessage("claude", { outcome: "stopped" }));
    expect(rowText()).toBe("Import stopped. The sessions already read are in the sessions list.");
    expect(screen.queryByRole("progressbar")).toBeNull();
    // The import can be started again.
    expect(importAction("Import sessions from Claude Code").disabled).toBe(false);
  });

  it("settles with every count the service sent, and unfolds the failures on a press", async () => {
    const { stream } = await renderPanel("claude");
    await emit(
      stream,
      settledMessage("claude", {
        outcome: "finished",
        imported: 125,
        total: 128,
        alreadyHere: 34,
        failures: [{ source: "one.jsonl", reason: "truncated" }],
        unreadableFiles: ["two.jsonl", "three.jsonl"],
        attachedProjects: [],
      }),
    );
    const line =
      "Imported 125 of 128 sessions from Claude Code · 34 already here · 1 failed · " +
      "2 files could not be read.";
    const row = screen.getByRole("button", { name: line });
    expect(screen.queryByText("truncated", { exact: false })).toBeNull();
    fireEvent.click(row);
    expect(screen.getByText("truncated", { exact: false })).not.toBeNull();
    expect(screen.getByText("three.jsonl")).not.toBeNull();
  });

  it("draws a count only where there is one", async () => {
    const { stream } = await renderPanel("claude");
    await emit(
      stream,
      settledMessage("claude", {
        outcome: "finished",
        imported: 12,
        total: 12,
        alreadyHere: 0,
        failures: [],
        unreadableFiles: [],
        attachedProjects: [],
      }),
    );
    expect(rowText()).toBe("Imported 12 sessions from Claude Code.");
    // Nothing failed and every file was read, so nothing unfolds.
    expect(screen.queryByRole("button", { name: /Imported/u })).toBeNull();
  });

  it("names the projects the import attached on the same line", async () => {
    const { stream } = await renderPanel("claude");
    await emit(
      stream,
      settledMessage("claude", {
        outcome: "finished",
        imported: 125,
        total: 128,
        alreadyHere: 0,
        failures: [],
        unreadableFiles: [],
        attachedProjects: ["web", "api"],
      }),
    );
    expect(rowText()).toBe("Imported 125 of 128 sessions from Claude Code · attached web, api.");
  });

  it("draws a refused import in the service's own words, and Try again starts it again", async () => {
    const { stream, sent } = await renderPanel("codex");
    await emit(
      stream,
      settledMessage("codex", { outcome: "refused", reason: "The Codex folder is missing." }),
    );
    expect(rowText()).toContain("The Codex folder is missing.");
    expect(announced("assertive")).toBe("The Codex folder is missing.");
    act(() => {
      screen.getByRole("button", { name: "Try again" }).click();
    });
    await settle();
    expect(sent.begin).toStrictEqual([{ provider: "codex" }]);
  });
});
