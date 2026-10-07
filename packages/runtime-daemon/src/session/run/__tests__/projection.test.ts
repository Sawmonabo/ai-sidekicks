// The run row's guards over a real database: a state swap or a version advance decided from a stale
// read is refused whole and leaves the row as the write that won it left it.

import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RunIdSchema, type RunId } from "@ai-sidekicks/contracts/run/id";
import { SessionIdSchema, type SessionId } from "@ai-sidekicks/contracts/session/id";

import {
  openScratchDatabase,
  type ScratchDatabase,
} from "../../../database/__fixtures__/scratch.js";
import type { WriteStatement } from "../../../database/statement.js";
import { WriteRefusedError } from "../../../database/writer.js";
import {
  advanceRunVersionStatement,
  insertQueuedRunStatement,
  swapRunStateStatement,
} from "../projection.js";
import { RunStateReader } from "../read.js";

describe("run state projection", () => {
  let database: ScratchDatabase;
  let runs: RunStateReader;
  let sessionId: SessionId;
  let runId: RunId;

  beforeEach(async () => {
    database = await openScratchDatabase();
    runs = new RunStateReader(database.reader);
    sessionId = SessionIdSchema.parse(randomUUID());
    runId = RunIdSchema.parse(randomUUID());
    await database.writer.write([
      insertQueuedRunStatement({ sessionId, runId, runVersion: 0, newState: "queued" }),
    ]);
  });

  afterEach(async () => {
    await database.close();
  });

  async function expectRefusedAtFirstStatement(statement: WriteStatement): Promise<void> {
    const refusal: unknown = await database.writer.write([statement]).catch((error) => error);
    expect(refusal).toBeInstanceOf(WriteRefusedError);
    expect(refusal).toMatchObject({ statementIndex: 0, rowCount: 0 });
  }

  it("reads the queued row, and nothing for a run it has no row for", () => {
    expect(runs.getRun(runId)).toEqual({ version: 0, sessionId, state: "queued" });
    expect(runs.getRun(RunIdSchema.parse(randomUUID()))).toBeUndefined();
  });

  it("commits the first of two swaps decided from one read and refuses the second", async () => {
    await database.writer.write([
      swapRunStateStatement({
        sessionId,
        runId,
        previousState: "queued",
        newState: "starting",
        runVersion: 1,
      }),
    ]);
    expect(runs.getRun(runId)).toEqual({ version: 1, sessionId, state: "starting" });

    await expectRefusedAtFirstStatement(
      swapRunStateStatement({
        sessionId,
        runId,
        previousState: "queued",
        newState: "failed",
        runVersion: 1,
      }),
    );
    expect(runs.getRun(runId)).toEqual({ version: 1, sessionId, state: "starting" });
  });

  it("refuses a swap from the right state at a version an intervention has since advanced", async () => {
    await database.writer.write([
      swapRunStateStatement({
        sessionId,
        runId,
        previousState: "queued",
        newState: "running",
        runVersion: 1,
      }),
    ]);
    await database.writer.write([
      advanceRunVersionStatement({ sessionId, runId, expectedRunVersion: 1 }),
    ]);
    expect(runs.getRun(runId)).toEqual({ version: 2, sessionId, state: "running" });

    // Decided from the read at version 1, so it claims version 2 the advance already took.
    await expectRefusedAtFirstStatement(
      swapRunStateStatement({
        sessionId,
        runId,
        previousState: "running",
        newState: "completed",
        runVersion: 2,
      }),
    );
    expect(runs.getRun(runId)).toEqual({ version: 2, sessionId, state: "running" });
  });

  it("refuses a swap at the right version from a state the run is not in", async () => {
    await expectRefusedAtFirstStatement(
      swapRunStateStatement({
        sessionId,
        runId,
        previousState: "running",
        newState: "completed",
        runVersion: 1,
      }),
    );
    expect(runs.getRun(runId)).toEqual({ version: 0, sessionId, state: "queued" });
  });

  it("refuses a swap or an advance that names the run under another session", async () => {
    const otherSessionId = SessionIdSchema.parse(randomUUID());
    await expectRefusedAtFirstStatement(
      swapRunStateStatement({
        sessionId: otherSessionId,
        runId,
        previousState: "queued",
        newState: "starting",
        runVersion: 1,
      }),
    );
    await expectRefusedAtFirstStatement(
      advanceRunVersionStatement({ sessionId: otherSessionId, runId, expectedRunVersion: 0 }),
    );
    expect(runs.getRun(runId)).toEqual({ version: 0, sessionId, state: "queued" });
  });

  it("refuses an advance from a version the run has moved past", async () => {
    await database.writer.write([
      advanceRunVersionStatement({ sessionId, runId, expectedRunVersion: 0 }),
    ]);
    expect(runs.getRun(runId)).toEqual({ version: 1, sessionId, state: "queued" });

    await expectRefusedAtFirstStatement(
      advanceRunVersionStatement({ sessionId, runId, expectedRunVersion: 0 }),
    );
    expect(runs.getRun(runId)).toEqual({ version: 1, sessionId, state: "queued" });
  });
});
