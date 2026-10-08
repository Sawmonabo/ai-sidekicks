// The workflow tables' guards against stored data going wrong: each tier refuses a value of the
// wrong storage class, a run's and a step's status and a step's wait state hold only what their
// CHECKs allow, a step's wait start is set exactly while it waits, one run never orders two steps
// at one execution index, a chain's count sits on its first run alone, one definition never stores
// the same bytes twice, a live workflow's name is taken once ignoring case, and a secret's row has
// nowhere to put its value. Statuses and causes are read from the contracts' lists, so a member
// added there fails here until the CHECK admits it.

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { foldName } from "@ai-sidekicks/contracts/name-fold";
import {
  WORKFLOW_RUN_STATUSES,
  WORKFLOW_STEP_STATUSES,
  WORKFLOW_WAIT_CAUSES,
} from "@ai-sidekicks/contracts/workflow/run/status";

import { openDatabase } from "../../session/migration-runner.js";

const TIMESTAMP = "2026-10-07T00:00:00.000Z";
const CHECK_FAILURE = /CHECK constraint failed/;
const WRONG_STORAGE_CLASS = /cannot store TEXT value in INTEGER column/;
const HASH_A = `b3:${"a".repeat(64)}`;

describe("workflow tables", () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  function insertDefinition(id: string, name: string = id): void {
    db.prepare(
      `INSERT INTO workflow_definitions
         (id, name, name_folded, content_hash, schema_version, definition_body, created_at,
          updated_at)
       VALUES (?, ?, ?, ?, '2', '{}', ?, ?)`,
    ).run(id, name, foldName(name), HASH_A, TIMESTAMP, TIMESTAMP);
  }

  function insertVersion(columns: {
    id: string;
    definitionId: string;
    versionNumber: unknown;
  }): void {
    db.prepare(
      `INSERT INTO workflow_versions
         (id, definition_id, version_number, content_hash, schema_version, definition_body,
          created_at)
       VALUES (?, ?, ?, ?, '2', '{}', ?)`,
    ).run(columns.id, columns.definitionId, columns.versionNumber, HASH_A, TIMESTAMP);
  }

  function insertRun(columns: {
    id: string;
    status?: string;
    chainRootRunId?: string;
    chainRunCount?: number | null;
    chainKeptGoing?: number | null;
  }): void {
    const isFirstRun = (columns.chainRootRunId ?? columns.id) === columns.id;
    db.prepare(
      `INSERT INTO workflow_runs
         (id, workflow_version_id, session_id, status, mode, started_by, chain_root_run_id,
          chain_run_count, chain_kept_going, started_at)
       VALUES (?, 'version-1', 'session-1', ?, 'manual', '{"kind":"schedule"}', ?, ?, ?, ?)`,
    ).run(
      columns.id,
      columns.status ?? "new",
      columns.chainRootRunId ?? columns.id,
      columns.chainRunCount === undefined ? (isFirstRun ? 1 : null) : columns.chainRunCount,
      columns.chainKeptGoing === undefined ? (isFirstRun ? 0 : null) : columns.chainKeptGoing,
      TIMESTAMP,
    );
  }

  // A waiting step's wait start defaults to its start; any other step's to none.
  function insertStep(columns: {
    executionIndex: number;
    attempt?: unknown;
    status: string;
    waitCause?: string | null;
    resumeAt?: string | null;
    waitAccountId?: string | null;
    waitDeadlineAt?: string | null;
    waitStartedAt?: string | null;
  }): void {
    const defaultWaitStartedAt = columns.status === "waiting" ? TIMESTAMP : null;
    db.prepare(
      `INSERT INTO workflow_steps
         (workflow_run_id, node_id, attempt, execution_index, status, wait_cause, resume_at,
          wait_account_id, wait_deadline_at, wait_started_at, started_at, input_ref, output_ref,
          log_ref)
       VALUES ('run-1', 'node-1', ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', '{}', '{}')`,
    ).run(
      columns.attempt ?? 1,
      columns.executionIndex,
      columns.status,
      columns.waitCause ?? null,
      columns.resumeAt ?? null,
      columns.waitAccountId ?? null,
      columns.waitDeadlineAt ?? null,
      columns.waitStartedAt === undefined ? defaultWaitStartedAt : columns.waitStartedAt,
      TIMESTAMP,
    );
  }

  function seedRun(): void {
    insertDefinition("definition-1");
    insertVersion({ id: "version-1", definitionId: "definition-1", versionNumber: 1 });
    insertRun({ id: "run-1" });
  }

  it("refuses a value of the wrong storage class on a table of each tier", () => {
    seedRun();
    // Numeric text would be converted losslessly, so each value is a word.
    expect(() => {
      insertVersion({ id: "version-text", definitionId: "definition-1", versionNumber: "two" });
    }).toThrow(WRONG_STORAGE_CLASS);
    expect(() => {
      insertStep({ executionIndex: 1, attempt: "first", status: "running" });
    }).toThrow(WRONG_STORAGE_CLASS);
    expect(() => {
      db.prepare(
        `INSERT INTO workflow_drafts (definition_id, based_on_version_number, document_json,
           updated_at) VALUES ('definition-1', 'seven', '{}', ?)`,
      ).run(TIMESTAMP);
    }).toThrow(WRONG_STORAGE_CLASS);
  });

  it("holds a step's status and wait state to their CHECKs", () => {
    seedRun();
    let executionIndex = 0;
    for (const status of WORKFLOW_STEP_STATUSES) {
      executionIndex += 1;
      insertStep({
        executionIndex,
        status,
        waitCause: status === "waiting" ? "approval" : null,
      });
    }
    for (const waitCause of WORKFLOW_WAIT_CAUSES) {
      executionIndex += 1;
      insertStep({ executionIndex, status: "waiting", waitCause });
    }
    expect(() => {
      insertStep({ executionIndex: 100, status: "paused" });
    }).toThrow(CHECK_FAILURE);
    expect(() => {
      insertStep({ executionIndex: 100, status: "waiting", waitCause: "timer" });
    }).toThrow(CHECK_FAILURE);
    expect(() => {
      insertStep({ executionIndex: 100, status: "waiting" });
    }).toThrow(CHECK_FAILURE);
    expect(() => {
      insertStep({ executionIndex: 100, status: "waiting-memory", waitCause: "account" });
    }).toThrow(CHECK_FAILURE);
    // A wait start without a wait, or a wait without its start.
    expect(() => {
      insertStep({ executionIndex: 100, status: "running", waitStartedAt: TIMESTAMP });
    }).toThrow(CHECK_FAILURE);
    expect(() => {
      insertStep({
        executionIndex: 100,
        status: "waiting",
        waitCause: "approval",
        waitStartedAt: null,
      });
    }).toThrow(CHECK_FAILURE);
  });

  it("orders one run's steps at distinct execution indexes", () => {
    seedRun();
    insertStep({ executionIndex: 1, status: "succeeded" });
    // Another attempt is another step key, so only the run's order can refuse it.
    expect(() => {
      insertStep({ executionIndex: 1, attempt: 2, status: "running" });
    }).toThrow(
      /UNIQUE constraint failed: workflow_steps\.workflow_run_id, workflow_steps\.execution_index/,
    );
  });

  it("refuses a move out of waiting that leaves a live wait column set", () => {
    seedRun();
    insertStep({
      executionIndex: 1,
      status: "waiting",
      waitCause: "account",
      resumeAt: TIMESTAMP,
      waitAccountId: "account-1",
    });
    insertStep({
      executionIndex: 2,
      status: "waiting",
      waitCause: "approval",
      waitDeadlineAt: TIMESTAMP,
    });
    // Each refused update clears the cause, so only a live-column CHECK can refuse it.
    const leaveOneSet = [
      { executionIndex: 1, kept: "resume_at" },
      { executionIndex: 1, kept: "wait_account_id" },
      { executionIndex: 2, kept: "wait_deadline_at" },
      { executionIndex: 2, kept: "wait_started_at" },
    ] as const;
    for (const { executionIndex, kept } of leaveOneSet) {
      const cleared = ["resume_at", "wait_account_id", "wait_deadline_at", "wait_started_at"]
        .filter((column) => column !== kept)
        .map((column) => `${column} = NULL`)
        .join(", ");
      expect(() => {
        db.prepare(
          `UPDATE workflow_steps SET status = 'succeeded', wait_cause = NULL, ${cleared}
           WHERE workflow_run_id = 'run-1' AND execution_index = ?`,
        ).run(executionIndex);
      }).toThrow(CHECK_FAILURE);
    }
    const settled = db
      .prepare(
        `UPDATE workflow_steps SET status = 'succeeded', wait_cause = NULL, resume_at = NULL,
           wait_account_id = NULL, wait_deadline_at = NULL, wait_started_at = NULL
         WHERE workflow_run_id = 'run-1'`,
      )
      .run();
    expect(settled.changes).toBe(2);
  });

  it("holds a run's status and its chain columns to their CHECKs", () => {
    seedRun();
    for (const status of WORKFLOW_RUN_STATUSES) {
      insertRun({ id: `run-${status}`, status });
    }
    expect(() => {
      insertRun({ id: "run-queued", status: "queued" });
    }).toThrow(CHECK_FAILURE);

    insertRun({ id: "run-later", chainRootRunId: "run-1" });
    // A first run without its count.
    expect(() => {
      insertRun({ id: "run-uncounted", chainRunCount: null, chainKeptGoing: null });
    }).toThrow(CHECK_FAILURE);
    // A first run with a count but no answer.
    expect(() => {
      insertRun({ id: "run-unanswered", chainKeptGoing: null });
    }).toThrow(CHECK_FAILURE);
    // A later run carrying a count and an answer of its own.
    expect(() => {
      insertRun({
        id: "run-later-counted",
        chainRootRunId: "run-1",
        chainRunCount: 2,
        chainKeptGoing: 0,
      });
    }).toThrow(CHECK_FAILURE);
  });

  it("takes a live workflow's name once, ignoring case, and frees it on delete", () => {
    insertDefinition("definition-1", "Nightly");
    expect(() => {
      insertDefinition("definition-2", "NIGHTLY");
    }).toThrow(/UNIQUE constraint failed: workflow_definitions\.name_folded/);
    db.prepare("UPDATE workflow_definitions SET deleted_at = ? WHERE id = 'definition-1'").run(
      TIMESTAMP,
    );
    insertDefinition("definition-2", "NIGHTLY");
  });

  it("gives a secret's row no column that could hold its value", () => {
    const columns = db
      .prepare("SELECT name FROM pragma_table_info('workflow_secrets') ORDER BY cid")
      .all() as { name: string }[];
    expect(columns.map((column) => column.name)).toEqual([
      "id",
      "scope",
      "scope_ref",
      "name",
      "created_at",
      "updated_at",
      "removal_requested_at",
    ]);
  });
});
