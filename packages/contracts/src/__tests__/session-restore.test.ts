// An undo and its result: an edit and resend goes only with an undo of the conversation
// and the files together, and a result carries the files' figures exactly when the
// files went back.
import { describe, expect, it } from "vitest";

import { SessionRestoreRequestSchema, SessionRestoreResultSchema } from "../session-restore.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const MESSAGE_TARGET = { kind: "message", anchorCursor: "evt-0042" };
const IDEMPOTENCY_KEY = "00000000-0000-4000-8000-000000000021";

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

  const filesOutcome = {
    restoredFileCount: 3,
    restoredLineCount: 41,
    skipped: [{ path: "vendor/link", reason: "symbolic_link" }],
  };

  it("accepts an undo whose files went back, with their own figures, and whose conversation did not", () => {
    const result = {
      outcome: "restore-finished",
      requested: "conversation-and-files",
      restored: "files",
      files: filesOutcome,
      failures: { conversation: { reason: "The provider refused the cut." } },
    };
    expect(SessionRestoreResultSchema.safeParse(result).success).toBe(true);
  });

  it("refuses files that went back with no figures, and figures where no files went back", () => {
    const withoutFigures = { outcome: "restore-finished", requested: "files", restored: "files" };
    expect(SessionRestoreResultSchema.safeParse(withoutFigures).success).toBe(false);
    const figuresWithoutFiles = {
      outcome: "restore-finished",
      requested: "conversation-and-files",
      restored: "conversation",
      files: filesOutcome,
      failures: { files: { reason: "A file is locked." } },
    };
    expect(SessionRestoreResultSchema.safeParse(figuresWithoutFiles).success).toBe(false);
  });
});
