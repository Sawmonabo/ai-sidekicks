// A chain's count lives on its first run's row and is raised by the write that creates each run
// joining it; a lost or doubled count would let a chain run past the person's question or ask it
// too soon.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WorkflowRunId } from "@ai-sidekicks/contracts/workflow/run/id";

import {
  openScratchDatabase,
  type ScratchDatabase,
} from "../../../database/__fixtures__/scratch.js";
import { createFixtureRun, insertWorkflowVersion } from "../__fixtures__/rows.js";

interface ChainColumns {
  readonly chain_root_run_id: string;
  readonly chain_from_error: number;
  readonly chain_run_count: number | null;
  readonly chain_kept_going: number | null;
}

let database: ScratchDatabase;

beforeEach(async () => {
  database = await openScratchDatabase();
});

afterEach(async () => {
  await database.close();
});

function readChain(workflowRunId: WorkflowRunId): ChainColumns | undefined {
  return database.reader
    .prepare(
      `SELECT chain_root_run_id, chain_from_error, chain_run_count, chain_kept_going
         FROM workflow_runs WHERE id = ?`,
    )
    .get(workflowRunId) as ChainColumns | undefined;
}

describe("a run's place in its chain", () => {
  it("counts each run that joins on the first run's row, in the write creating it", async () => {
    const versionId = await insertWorkflowVersion(database.writer, "Summarize folder");
    const firstRunId = await createFixtureRun(database.writer, versionId);
    expect(readChain(firstRunId)).toEqual({
      chain_root_run_id: firstRunId,
      chain_from_error: 0,
      chain_run_count: 1,
      chain_kept_going: 0,
    });

    const joinedRunId = await createFixtureRun(database.writer, versionId, {
      chain: { kind: "joins", chainRootRunId: firstRunId, isFromError: false },
    });
    expect(readChain(firstRunId)?.chain_run_count).toBe(2);

    const errorRunId = await createFixtureRun(database.writer, versionId, {
      chain: { kind: "joins", chainRootRunId: firstRunId, isFromError: true },
    });
    expect(readChain(firstRunId)?.chain_run_count).toBe(3);
    expect(readChain(joinedRunId)).toEqual({
      chain_root_run_id: firstRunId,
      chain_from_error: 0,
      chain_run_count: null,
      chain_kept_going: null,
    });
    expect(readChain(errorRunId)).toMatchObject({
      chain_root_run_id: firstRunId,
      chain_from_error: 1,
    });

    // A run that starts a chain of its own counts itself and leaves the earlier chain's count.
    const newChainRunId = await createFixtureRun(database.writer, versionId);
    expect(readChain(newChainRunId)).toMatchObject({
      chain_root_run_id: newChainRunId,
      chain_run_count: 1,
    });
    expect(readChain(firstRunId)?.chain_run_count).toBe(3);
  });
});
