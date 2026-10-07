// Paging through the runs list must list each run once, even where runs share a creation instant
// and while runs start and new ones are created between pages, or the runs table would show a run
// twice or never.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WorkflowRunId } from "@ai-sidekicks/contracts/workflow/run/id";

import {
  openScratchDatabase,
  type ScratchDatabase,
} from "../../../database/__fixtures__/scratch.js";
import {
  createFixtureRun,
  insertWorkflowVersion,
  setFixtureRunStatus,
} from "../__fixtures__/rows.js";
import { WorkflowRunStore } from "../store.js";

// Seven runs over four creation instants, three of them shared.
const CREATION_INSTANTS = [
  "2026-10-02T00:00:00.000Z",
  "2026-10-02T00:00:00.000Z",
  "2026-10-02T00:00:00.000Z",
  "2026-10-02T01:00:00.000Z",
  "2026-10-02T01:00:00.000Z",
  "2026-10-02T02:00:00.000Z",
  "2026-10-02T03:00:00.000Z",
];
const PAGE_SIZE = 3;

let database: ScratchDatabase;

beforeEach(async () => {
  database = await openScratchDatabase();
});

afterEach(async () => {
  await database.close();
});

describe("paging the runs list", () => {
  it("lists every run exactly once across pages", async () => {
    const versionId = await insertWorkflowVersion(database.writer, "Nightly review");
    const runIds: WorkflowRunId[] = [];
    for (const createdAt of CREATION_INSTANTS) {
      runIds.push(
        await createFixtureRun(database.writer, versionId, { createdAt: new Date(createdAt) }),
      );
    }
    const store = new WorkflowRunStore(database);

    const listedRunIds: WorkflowRunId[] = [];
    let cursor: string | undefined;
    let pageCount = 0;
    do {
      const page = store.list({ limit: PAGE_SIZE, cursor });
      expect(page.totalCount).toBe(runIds.length + pageCount);
      listedRunIds.push(...page.runs.map((run) => run.workflowRunId));
      cursor = page.nextCursor;
      pageCount += 1;
      // Between pages a listed run starts and a newer run is created; neither moves the pages.
      const startedRunId = runIds[pageCount];
      if (startedRunId !== undefined) {
        await setFixtureRunStatus(
          database.writer,
          startedRunId,
          "running",
          "2026-10-02T04:00:00.000Z",
          null,
        );
      }
      await createFixtureRun(database.writer, versionId, {
        createdAt: new Date("2026-10-02T05:00:00.000Z"),
      });
    } while (cursor !== undefined);

    expect(pageCount).toBe(Math.ceil(runIds.length / PAGE_SIZE));
    expect([...listedRunIds].sort()).toEqual([...runIds].sort());
  });
});
