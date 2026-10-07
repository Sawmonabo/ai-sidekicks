// One provider's session import from its panel, end to end.
//
// The panel and the model above it are the real modules; the three calls are stubs. Asserts the
// stream opens on the section's provider before anything is pressed, what the action and `Stop`
// send, that the one progress row says how the import stands in the service's own counts, and
// that only what changed while the panel was open is said: the outcome the stream replays as it
// opens is drawn and left to browsing.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type {
  ProviderImportId,
  ProviderImportOutcome,
  ProviderImportProgress,
} from "@ai-sidekicks/contracts/provider/import";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import { RefusalError, refuse } from "#renderer/lib/refusal/contract.js";
import { ProviderImportPanel } from "./ProviderImportPanel.js";
import { useProviderImport, type ProviderImportCalls } from "../hooks/useProviderImport.js";
import { DrivenProgressStream } from "../progress.test-support.js";
import { settle } from "#test/helpers/settle.js";
import { spiedAnnouncer, type SpiedAnnouncer } from "#test/helpers/spied-announcer.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";

/** The id the stubbed start answers the first press with. */
const IMPORT_ID = "provider-import-3" as ProviderImportId;

/** The id the stubbed start answers every later press with: the daemon starts a new import. */
const RETRIED_IMPORT_ID = "provider-import-4" as ProviderImportId;

/** An import from before the panel opened, whose outcome the stream replays first. */
const EARLIER_IMPORT_ID = "provider-import-2" as ProviderImportId;

/** An import that found nothing new, and the row's words for it. */
const NOTHING_NEW: ProviderImportOutcome = {
  outcome: "nothingNew",
  alreadyHere: 4,
  unreadableFiles: [],
};

const NOTHING_NEW_SENTENCE = "Nothing new to import from Codex · 4 already here.";

/** What each call received, in order. */
interface SentRequests {
  readonly begin: unknown[];
  readonly subscribe: unknown[];
  readonly stop: unknown[];
}

/** What the stubbed start answers when a case has it refuse. */
const START_REFUSAL = refuse("daemon", "session.import_unavailable", "The import service is down.");

/** The three calls, each recording what it was sent; every subscription opens a fresh stream. */
function recordingCalls(options: { readonly isStartRefused: boolean }): {
  readonly calls: ProviderImportCalls;
  readonly sent: SentRequests;
  readonly opened: readonly DrivenProgressStream[];
} {
  const sent: SentRequests = { begin: [], subscribe: [], stop: [] };
  const opened: DrivenProgressStream[] = [];
  return {
    sent,
    opened,
    calls: {
      begin: async (request) => {
        sent.begin.push(request);
        if (options.isStartRefused) {
          throw new RefusalError(START_REFUSAL);
        }
        return await Promise.resolve({
          importId: sent.begin.length === 1 ? IMPORT_ID : RETRIED_IMPORT_ID,
        });
      },
      subscribe: async (request) => {
        sent.subscribe.push(request);
        const stream = new DrivenProgressStream();
        opened.push(stream);
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

/** Mount one provider's panel and let its stream open; `opened` holds every stream opened. */
async function renderPanel(
  provider: ProviderName,
  options: { readonly isStartRefused: boolean } = { isStartRefused: false },
): Promise<{
  readonly stream: DrivenProgressStream;
  readonly opened: readonly DrivenProgressStream[];
  readonly sent: SentRequests;
  readonly said: SpiedAnnouncer;
}> {
  const { calls, sent, opened } = recordingCalls(options);
  const said = spiedAnnouncer();
  render(
    <LiveAnnouncerProvider announcer={said.announcer}>
      <ImportHarness provider={provider} calls={calls} />
    </LiveAnnouncerProvider>,
  );
  await settle();
  const [stream] = opened;
  if (stream === undefined) {
    throw new Error("the panel opened no import stream");
  }
  return { stream, opened, sent, said };
}

async function emit(stream: DrivenProgressStream, message: ProviderImportProgress): Promise<void> {
  stream.emit(message);
  await settle();
}

function settledMessage(
  provider: ProviderName,
  settlement: ProviderImportOutcome,
  importId: ProviderImportId = IMPORT_ID,
): ProviderImportProgress {
  return { kind: "settled", provider, importId, settlement };
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

describe("one provider's import", () => {
  it("opens the provider's stream before anything is pressed, and draws its last outcome unsaid", async () => {
    const { stream, sent, said } = await renderPanel("codex");
    expect(sent.subscribe).toStrictEqual([{ provider: "codex" }]);
    expect(sent.begin).toStrictEqual([]);

    await emit(
      stream,
      settledMessage("codex", { outcome: "nothingNew", alreadyHere: 4, unreadableFiles: [] }),
    );
    expect(rowText()).toBe("Nothing new to import from Codex · 4 already here.");
    // The outcome was already true when the person arrived: it is browsed, not said.
    expect(said.spoken()).toStrictEqual([]);
    // History is not a running import: the action stays offered.
    expect(importAction("Import sessions from Codex").disabled).toBe(false);
  });

  it("starts on the press, counts what it reads, and stops on Stop with the running import", async () => {
    const { stream, sent, said } = await renderPanel("claude");
    // Negative control: nothing is running, so there is nothing to stop.
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();

    act(() => {
      importAction("Import sessions from Claude Code").click();
    });
    await settle();
    expect(sent.begin).toStrictEqual([{ provider: "claude" }]);
    expect(importAction("Import sessions from Claude Code").disabled).toBe(true);

    await emit(stream, { kind: "progress", provider: "claude", importId: IMPORT_ID, read: 128 });
    await emit(stream, { kind: "progress", provider: "claude", importId: IMPORT_ID, read: 256 });
    expect(rowText()).toContain("Importing from Claude Code… 256 read.");
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
    // The running import is said once, never its counts, and the outcome it reached once.
    expect(said.spoken()).toStrictEqual([
      "Importing from Claude Code…",
      "Import stopped. The sessions already read are in the sessions list.",
    ]);
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
    const { stream, sent, said } = await renderPanel("codex");
    const refusal: ProviderImportOutcome = {
      outcome: "refused",
      reason: "The Codex folder is missing.",
    };
    await emit(stream, settledMessage("codex", refusal, EARLIER_IMPORT_ID));
    expect(rowText()).toContain("The Codex folder is missing.");
    // Replayed as the stream opened, so it stands; the same refusal answering a press is news.
    expect(said.spokenOn("assertive")).toStrictEqual([]);
    act(() => {
      screen.getByRole("button", { name: "Try again" }).click();
    });
    await settle();
    expect(sent.begin).toStrictEqual([{ provider: "codex" }]);
    // Until the started import settles, the row reports it running, never the old refusal.
    expect(said.spokenOn("assertive")).toStrictEqual([]);
    await emit(stream, settledMessage("codex", refusal));
    expect(said.spokenOn("assertive")).toStrictEqual(["The Codex folder is missing."]);
  });

  it("says the import again when Try again retries one a press started, in the same words", async () => {
    const { stream, sent, said } = await renderPanel("codex");
    act(() => {
      importAction("Import sessions from Codex").click();
    });
    await settle();
    await emit(
      stream,
      settledMessage("codex", { outcome: "refused", reason: "The Codex folder is missing." }),
    );
    expect(said.spokenOn("polite")).toStrictEqual(["Importing from Codex…"]);
    // The stream's first message, but the outcome of this press: news, not a replay.
    expect(said.spokenOn("assertive")).toStrictEqual(["The Codex folder is missing."]);

    act(() => {
      screen.getByRole("button", { name: "Try again" }).click();
    });
    await settle();
    expect(sent.begin).toStrictEqual([{ provider: "codex" }, { provider: "codex" }]);
    expect(rowText()).toContain("Importing from Codex…");
    // The retry is the person's own new press: said once, though its words match the first's.
    expect(said.spokenOn("polite")).toStrictEqual([
      "Importing from Codex…",
      "Importing from Codex…",
    ]);
  });

  it("leaves the replayed outcome unsaid when a press is refused before any import starts", async () => {
    const { stream, said } = await renderPanel("codex", { isStartRefused: true });
    await emit(stream, settledMessage("codex", NOTHING_NEW, EARLIER_IMPORT_ID));
    act(() => {
      importAction("Import sessions from Codex").click();
    });
    await settle();
    expect(said.spokenOn("assertive")).toStrictEqual(["The import service is down."]);
    // The row shows the replay again, which no import this press began has reached.
    expect(rowText()).toBe(NOTHING_NEW_SENTENCE);
    expect(said.spokenOn("polite")).toStrictEqual(["Importing from Codex…"]);
  });

  it("keeps a settled import ended, and unsaid, while its failed stream opens again", async () => {
    const { stream, opened, said } = await renderPanel("codex");
    act(() => {
      importAction("Import sessions from Codex").click();
    });
    await settle();
    await emit(stream, settledMessage("codex", NOTHING_NEW));
    stream.fail(new Error("The import stream was dropped."));
    await settle();
    act(() => {
      screen.getByRole("button", { name: "Try again" }).click();
    });
    await settle();
    // Before the new opening speaks, the import already seen to end is not running again.
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(rowText()).toBe(NOTHING_NEW_SENTENCE);

    const [, reopened] = opened;
    if (reopened === undefined) {
      throw new Error("Try again opened no second stream");
    }
    await emit(reopened, settledMessage("codex", NOTHING_NEW));
    // The opening re-read what was already said.
    expect(said.spokenOn("polite")).toStrictEqual(["Importing from Codex…", NOTHING_NEW_SENTENCE]);
  });
});
