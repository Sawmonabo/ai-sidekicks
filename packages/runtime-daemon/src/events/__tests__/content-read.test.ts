// The read projection over the sealed content partition returns the stored body, reports a purged
// row as purged even if its bytes survived, and never fabricates a body on an unavailable path.

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CONTENT_LENGTH_PAYLOAD_KEY,
  CONTENT_TRUNCATED_PAYLOAD_KEY,
  EventEnvelopeVersionSchema,
  SessionIdSchema,
  type HydratedContentUnavailableReason,
  type HydratedSessionEvent,
  type SessionId,
} from "@ai-sidekicks/contracts";

import { openDatabase } from "../../session/migration-runner.js";
import { SessionContentReader, type StoredEventContentRow } from "../content-read.js";
import { writeEventWithPii } from "../pii-indirection.js";
import { SESSION_CONTENT_KEY_BYTES, SessionContentKeyStore } from "../session-content-key-store.js";
import { ScriptedMasterKeySource, nextEventId } from "./event-test-fixtures.js";

const SESSION: SessionId = SessionIdSchema.parse("0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f10");
const ENVELOPE_VERSION = EventEnvelopeVersionSchema.parse("1.0");
const MASTER_KEY = new Uint8Array(SESSION_CONTENT_KEY_BYTES).fill(3);

let database: DatabaseType;

beforeEach(() => {
  database = openDatabase(":memory:");
});

afterEach(() => {
  database.close();
});

/** Seals `body` under this session's real key and returns the row it produces. */
async function sealedRow(
  store: SessionContentKeyStore,
  body: string,
  extraPayload?: Record<string, unknown>,
): Promise<{ readonly row: StoredEventContentRow; readonly ciphertext: Uint8Array }> {
  const resolved = await store.resolveForWrite(SESSION);
  const written = await writeEventWithPii(
    {
      id: nextEventId(),
      sessionId: SESSION,
      sequence: 1,
      occurredAt: "2026-08-30T12:00:00.000Z",
      category: "assistant_output",
      type: "assistant.message",
      actor: "agent-1",
      // `assistant.message` has a registered `SessionEventSchema` variant, and the codec parses
      // the composed row against it before storing, so `sessionId` and `runId` are required.
      payload: { sessionId: SESSION, runId: "run-1", ...extraPayload },
      version: ENVELOPE_VERSION,
      content: { body, contentKey: resolved.key },
    },
    { encrypt: () => Promise.reject(new Error("no PII on this row")) },
  );
  // Checked rather than asserted: an absent column here would mean the codec silently dropped
  // the body, which the tests below exist to catch.
  const ciphertext: Uint8Array | undefined = written.contentPayload;
  if (ciphertext === undefined) {
    throw new Error(
      "the codec returned no content partition for an input that carries one — every row this helper builds seals a body",
    );
  }
  return {
    row: {
      envelope: written.envelope,
      contentPayload: ciphertext,
      retentionClass: null,
    },
    ciphertext,
  };
}

function buildReader(): {
  readonly reader: SessionContentReader;
  readonly store: SessionContentKeyStore;
  readonly masterKeySource: ScriptedMasterKeySource;
} {
  const masterKeySource = new ScriptedMasterKeySource(MASTER_KEY);
  const store = new SessionContentKeyStore({ database, masterKeySource });
  return { reader: new SessionContentReader({ keyReader: store }), store, masterKeySource };
}

function expectUnavailable(
  hydrated: HydratedSessionEvent,
  reason: HydratedContentUnavailableReason,
): void {
  expect(hydrated.content).toEqual({ status: "unavailable", reason });
}

describe("hydrating machine-authored prose", () => {
  it("returns the body and leaves the stored payload byte-identical", async () => {
    const { reader, store } = buildReader();
    const { row } = await sealedRow(store, "the model wrote this, verbatim");
    const payloadBefore = JSON.stringify(row.envelope.payload);

    const hydrated = await reader.hydrate(row);

    expect(hydrated.content).toEqual({
      status: "available",
      body: "the model wrote this, verbatim",
      contentLength: 30,
    });
    // The event passes through untouched, same object and same bytes.
    expect(hydrated.event).toBe(row.envelope);
    expect(JSON.stringify(hydrated.event.payload)).toBe(payloadBefore);
    expect(Object.hasOwn(hydrated.event.payload, "body")).toBe(false);
    // The body lives on the content arm only, so a caller can tell stored members from supplied
    // ones.
    expect(JSON.stringify(hydrated.event)).not.toContain("the model wrote this");
  });

  it("names the purge even if the column somehow survived it", async () => {
    const { reader, store } = buildReader();
    const { row } = await sealedRow(store, "the original prose");
    // A purged row that still holds bytes is a purge defect; the recorded purge is reported, not
    // the body the leftover bytes would open to.
    expectUnavailable(await reader.hydrate({ ...row, retentionClass: "audit_stub" }), "purged");
  });

  it("carries the truncation marker through from the stored payload", async () => {
    const { reader, store } = buildReader();
    const oversized = "a".repeat(262_144 + 10);
    const { row } = await sealedRow(store, oversized);

    const hydrated = await reader.hydrate(row);
    expect(hydrated.content).toEqual({
      status: "available",
      body: "a".repeat(262_144),
      contentLength: 262_154,
      contentTruncated: true,
    });
    // Echoed from the stored payload, never recomputed: a recomputed length would equal the
    // truncated length and hide the truncation.
    expect(row.envelope.payload[CONTENT_LENGTH_PAYLOAD_KEY]).toBe(262_154);
    expect(row.envelope.payload[CONTENT_TRUNCATED_PAYLOAD_KEY]).toBe(true);
  });

  it("never fabricates an empty body on any unavailable path", async () => {
    const { reader, store, masterKeySource } = buildReader();
    const { row } = await sealedRow(store, "the original prose");
    masterKeySource.failure = new Error("keystore is locked");

    const hydrated = await reader.hydrate(row);
    expect(hydrated.content.status).toBe("unavailable");
    expect(Object.hasOwn(hydrated.content, "body")).toBe(false);
  });
});
