// The run row's guards over a real database, each clause on its own: a swap from a version or a
// state the row no longer holds, and a swap or advance naming the run under another session, is
// refused whole and leaves the row as it was.

import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentIdSchema } from "@ai-sidekicks/contracts/agent/definition";
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
      insertQueuedRunStatement({
        sessionId,
        runId,
        runVersion: 0,
        newState: "queued",
        agentId: AgentIdSchema.parse(randomUUID()),
      }),
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

  it("refuses a swap by its version alone, by its state alone, and a swap or advance under another session", async () => {
    await database.writer.write([
      swapRunStateStatement({
        sessionId,
        runId,
        previousState: "queued",
        newState: "running",
        runVersion: 1,
      }),
    ]);
    await database.writer.write([advanceRunVersionStatement({ sessionId, runId })]);

    // From the right state, decided from the read at version 1 the advance has since moved past.
    await expectRefusedAtFirstStatement(
      swapRunStateStatement({
        sessionId,
        runId,
        previousState: "running",
        newState: "completed",
        runVersion: 2,
      }),
    );
    // At the right version, from a state the run is not in.
    await expectRefusedAtFirstStatement(
      swapRunStateStatement({
        sessionId,
        runId,
        previousState: "paused",
        newState: "running",
        runVersion: 3,
      }),
    );
    const otherSessionId = SessionIdSchema.parse(randomUUID());
    await expectRefusedAtFirstStatement(
      swapRunStateStatement({
        sessionId: otherSessionId,
        runId,
        previousState: "running",
        newState: "completed",
        runVersion: 3,
      }),
    );
    await expectRefusedAtFirstStatement(
      advanceRunVersionStatement({ sessionId: otherSessionId, runId }),
    );
    expect(runs.getRun(runId)).toEqual({ version: 2, sessionId, state: "running" });
  });
});
