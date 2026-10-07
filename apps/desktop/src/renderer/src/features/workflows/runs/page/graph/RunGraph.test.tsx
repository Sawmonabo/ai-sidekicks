// A run graph whose canvas code fails to load reads `Could not load the run graph` with
// `Retry`, and the browser's own failure text goes to the diagnostic capture, never the screen.

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WORKFLOW_FIXTURE_NOW_MS } from "#fixtures/data/workflow/clock.js";
import {
  WORKFLOW_DEFINITION_RECORDS,
  WORKFLOW_RUN_IDS,
  WORKFLOW_RUN_RECORDS,
} from "#fixtures/data/workflow/run/records.js";
import { EMPTY_SESSION_SCENARIO } from "#fixtures/scenarios/empty-session.js";
import { ManualClock } from "#renderer/lib/clock.js";
import { windowDiagnosticCapture } from "#renderer/lib/diagnostic-capture/capture.js";
import { createFixtureBridge } from "#renderer/services/platform/bridge.fixture.js";
import { PlatformBridgeProvider } from "#renderer/services/platform/PlatformBridgeProvider.js";
import { RunGraph } from "./RunGraph.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";

const { CHUNK_FAILURE_TEXT } = vi.hoisted(() => ({
  CHUNK_FAILURE_TEXT:
    "Failed to fetch dynamically imported module: " +
    "sidekicks-renderer://app/assets/RunGraphCanvas-4f2a.js",
}));

vi.mock("./loader.js", async () => {
  const { MemoizedLoad } = await import("#renderer/lib/memoized-load.js");
  return {
    runGraphLoader: new MemoizedLoad(() => Promise.reject(new Error(CHUNK_FAILURE_TEXT))),
  };
});

let detachForwarder: (() => void) | undefined;

afterEach(() => {
  detachForwarder?.();
  detachForwarder = undefined;
});

describe("the run graph when its canvas code fails to load", () => {
  it("says it could not load the graph and logs the browser's own text", async () => {
    const run = WORKFLOW_RUN_RECORDS.find(
      (record) => record.read.workflowRunId === WORKFLOW_RUN_IDS.succeeded,
    )?.read;
    const document = WORKFLOW_DEFINITION_RECORDS.flatMap((record) => record.versions).find(
      (version) => version.versionId === run?.workflowVersionId,
    )?.document;
    if (run === undefined || document === undefined) {
      throw new Error("the fixture's finished run or its document is missing");
    }
    const batches: string[] = [];
    detachForwarder = windowDiagnosticCapture.installForwarder((jsonLines) => {
      batches.push(jsonLines);
    });
    const fixture = createFixtureBridge({ scenario: EMPTY_SESSION_SCENARIO });
    const { container } = render(
      <PlatformBridgeProvider bridge={fixture.bridge} clock={new ManualClock(0)}>
        <RunGraph
          document={document}
          steps={run.steps}
          edgeItemCounts={run.edgeItemCounts}
          selectedNodeId={undefined}
          nowMs={WORKFLOW_FIXTURE_NOW_MS}
          onSelectNode={() => undefined}
        />
      </PlatformBridgeProvider>,
      { wrapper: LiveAnnouncerProvider },
    );

    expect(await screen.findByText("Could not load the run graph")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(container.textContent).not.toContain("sidekicks-renderer://");
    expect(container.textContent).not.toContain("Failed to fetch");

    windowDiagnosticCapture.flush();
    const records = batches
      .flatMap((batch) => batch.split("\n"))
      .map((line) => JSON.parse(line) as { severity: string; detail: string });
    expect(records).toContainEqual(
      expect.objectContaining({ severity: "error", detail: CHUNK_FAILURE_TEXT }),
    );
  });
});
