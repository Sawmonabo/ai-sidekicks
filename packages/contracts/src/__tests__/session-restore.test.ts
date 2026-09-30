// Undo's dry run, the undo, its settled event and the snapshot list: each accepts the
// shape the session screen sends or draws, and refuses the cases the design names.
import { describe, expect, it } from "vitest";

import {
  SessionRestoreFinishedPayloadSchema,
  SessionRestorePreviewRequestSchema,
  SessionRestorePreviewResponseSchema,
  SessionRestoreRequestSchema,
  SessionRestoreResultSchema,
  SessionSnapshotListResponseSchema,
} from "../session-restore.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_SESSION_ID = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const MESSAGE_TARGET = { kind: "message", anchorCursor: "evt-0042" };
const SNAPSHOT_TARGET = { kind: "snapshot", snapshotId: "turn-7" };
const IDEMPOTENCY_KEY = "00000000-0000-4000-8000-000000000021";

describe("session.restorePreview", () => {
  it("accepts a message or a snapshot as the point to go back to", () => {
    for (const target of [MESSAGE_TARGET, SNAPSHOT_TARGET]) {
      const request = { sessionId: SESSION_ID, target, scope: "files" };
      expect(SessionRestorePreviewRequestSchema.safeParse(request).success).toBe(true);
    }
  });

  it("refuses a scope outside the three the rewind menu offers", () => {
    const request = { sessionId: SESSION_ID, target: MESSAGE_TARGET, scope: "everything" };
    expect(SessionRestorePreviewRequestSchema.safeParse(request).success).toBe(false);
  });

  const preview = {
    fileCount: 3,
    lineCount: 41,
    skipped: [{ path: "build/app.bin", reason: "too_large" }],
    affectedChildCount: 2,
    runningCommands: 1,
    ignoredFolders: ["node_modules/", "dist/"],
    commandsRanAfterPoint: true,
    alsoChangedBy: [{ sessionId: OTHER_SESSION_ID, paths: ["src/app.ts"] }],
  };

  it("accepts the dry run the question states", () => {
    expect(SessionRestorePreviewResponseSchema.safeParse(preview).success).toBe(true);
  });

  it("refuses a skip whose reason is not one the dry run names", () => {
    const withUnknownSkip = { ...preview, skipped: [{ path: "a.txt", reason: "locked" }] };
    expect(SessionRestorePreviewResponseSchema.safeParse(withUnknownSkip).success).toBe(false);
  });
});

describe("session.restore", () => {
  const undo = {
    sessionId: SESSION_ID,
    target: MESSAGE_TARGET,
    scope: "conversation-and-files",
    clientIdempotencyKey: IDEMPOTENCY_KEY,
    includeAlsoChanged: false,
  };

  it("accepts an edit and resend at the conversation-and-files scope", () => {
    const request = { ...undo, resend: { content: "Use the staging database instead" } };
    expect(SessionRestoreRequestSchema.safeParse(request).success).toBe(true);
  });

  it("refuses an edit and resend that would put back only the files", () => {
    const request = { ...undo, scope: "files", resend: { content: "Use staging" } };
    expect(SessionRestoreRequestSchema.safeParse(request).success).toBe(false);
  });

  it("refuses an undo without its idempotency key", () => {
    const { clientIdempotencyKey: _omitted, ...withoutKey } = undo;
    expect(SessionRestoreRequestSchema.safeParse(withoutKey).success).toBe(false);
  });

  it("accepts an undo whose files went back and whose conversation did not", () => {
    const result = {
      outcome: "restore-finished",
      requested: "conversation-and-files",
      restored: "files",
      failures: { conversation: { reason: "The provider refused the cut." } },
    };
    expect(SessionRestoreResultSchema.safeParse(result).success).toBe(true);
  });

  it("refuses a restored part outside the three and nothing", () => {
    const result = { outcome: "restore-finished", requested: "files", restored: "some" };
    expect(SessionRestoreResultSchema.safeParse(result).success).toBe(false);
  });

  it("accepts the settled event with the files part's own figures", () => {
    const payload = {
      sessionId: SESSION_ID,
      target: SNAPSHOT_TARGET,
      result: { outcome: "restore-finished", requested: "files", restored: "files" },
      files: {
        restoredFileCount: 3,
        restoredLineCount: 41,
        skipped: [{ path: "vendor/link", reason: "symbolic_link" }],
      },
    };
    expect(SessionRestoreFinishedPayloadSchema.safeParse(payload).success).toBe(true);
  });
});

describe("session.snapshotList", () => {
  it("accepts the inspector's snapshot rows", () => {
    const response = {
      snapshots: [
        { snapshotId: "turn-7", name: "Before turn 7", createdAt: "2026-09-29T17:00:00.000Z" },
      ],
    };
    expect(SessionSnapshotListResponseSchema.safeParse(response).success).toBe(true);
  });
});
