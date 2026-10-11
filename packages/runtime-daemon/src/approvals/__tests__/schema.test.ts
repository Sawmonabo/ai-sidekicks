// The approval tables refuse a row that would let one answer reach two asks or two answers settle
// one: a second ask for one ask id, a second answer to one ask, and an answer to an ask that does
// not exist.

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";

import { applyMigrations, applyPragmas } from "../../session/migration-runner.js";

const TIMESTAMP = "2026-10-11T00:00:00.000Z";
const REQUEST_ID = "00000000-0000-7000-8000-0000000000a1";
const ANSWERED_REQUEST_ID = "00000000-0000-7000-8000-0000000000a2";
const RUN_ID = "00000000-0000-7000-8000-0000000000b1";
const ASK_ID = "00000000-0000-7000-8000-0000000000d1";

let db: DatabaseType;

function insertRequest(row: Record<string, unknown>): void {
  db.prepare(
    `INSERT INTO approval_requests
       (id, session_id, run_id, requested_by, category, scope, resource_descriptor, ask_id, state,
        created_at, updated_at)
     VALUES (@id, @session_id, @run_id, @requested_by, @category, @scope, '{}', @ask_id, @state,
             @at, @at)`,
  ).run({
    id: REQUEST_ID,
    session_id: "00000000-0000-7000-8000-0000000000c1",
    run_id: RUN_ID,
    requested_by: "agent-1",
    category: "tool_execution",
    scope: "git push",
    ask_id: null,
    state: "pending",
    at: TIMESTAMP,
    ...row,
  });
}

function insertResolution(row: Record<string, unknown>): void {
  db.prepare(
    `INSERT INTO approval_resolutions
       (request_id, device_id, client_resolution_id, decision, effective_scope,
        remembered_scope_kind, remembered_scope_pattern, resolved_at)
     VALUES (@request_id, 'device-1', '00000000-0000-4000-8000-000000000001', @decision,
             @effective_scope, @remembered_scope_kind, @remembered_scope_pattern, @at)`,
  ).run({
    request_id: REQUEST_ID,
    decision: "approved",
    effective_scope: "git push",
    remembered_scope_kind: null,
    remembered_scope_pattern: null,
    at: TIMESTAMP,
    ...row,
  });
}

beforeEach(() => {
  db = new Database(":memory:");
  applyPragmas(db);
  applyMigrations(db);
  // An answered ask on a provider ask, which every refusal below is checked beside.
  insertRequest({ id: ANSWERED_REQUEST_ID, ask_id: ASK_ID, state: "approved" });
  insertResolution({
    request_id: ANSWERED_REQUEST_ID,
    remembered_scope_kind: "session",
    remembered_scope_pattern: "git push",
  });
});

afterEach(() => {
  db.close();
});

it.each([
  ["a second ask for one ask id", () => insertRequest({ ask_id: ASK_ID }), /UNIQUE/],
  [
    "a second answer to one ask",
    () => insertResolution({ request_id: ANSWERED_REQUEST_ID }),
    /UNIQUE|PRIMARY KEY/,
  ],
  ["an answer to an ask that does not exist", () => insertResolution({}), /FOREIGN KEY/],
])("refuses %s", (_case, write, refusal) => {
  expect(write).toThrow(refusal);
});
