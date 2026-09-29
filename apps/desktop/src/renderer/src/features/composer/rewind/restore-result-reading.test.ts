// Every row an undo can draw, against the design's own words: every part applied, part
// applied, nothing applied, and a resend that failed after its undo applied, for a message
// and for a snapshot.

import { describe, expect, it } from "vitest";
import type { SessionRestoreResult } from "@ai-sidekicks/contracts";

import { readRestoreResult, type RestoreTarget } from "./restore-result-reading.js";

const MESSAGE: RestoreTarget = { kind: "message", firstWords: "Rename the config loader" };
const SNAPSHOT: RestoreTarget = { kind: "snapshot", name: "Before Rename the config loader" };

describe("an undo where every asked-for part went back", () => {
  it("reads the conversation and the files going back as `Restored to`", () => {
    const result: SessionRestoreResult = {
      outcome: "restore-finished",
      requested: "conversation-and-files",
      restored: "conversation-and-files",
    };
    expect(readRestoreResult(result, MESSAGE)).toBe("Restored to before Rename the config loader");
    expect(readRestoreResult(result, SNAPSHOT)).toBe("Restored to before Rename the config loader");
  });

  it("reads the conversation alone going back as `Restored to`", () => {
    const result: SessionRestoreResult = {
      outcome: "restore-finished",
      requested: "conversation",
      restored: "conversation",
    };
    expect(readRestoreResult(result, MESSAGE)).toBe("Restored to before Rename the config loader");
  });

  it("reads the files alone going back as `Files restored to`", () => {
    const result: SessionRestoreResult = {
      outcome: "restore-finished",
      requested: "files",
      restored: "files",
    };
    expect(readRestoreResult(result, MESSAGE)).toBe(
      "Files restored to before Rename the config loader",
    );
    expect(readRestoreResult(result, SNAPSHOT)).toBe(
      "Files restored to before Rename the config loader",
    );
  });

  it("keeps a snapshot name that opens on an acronym as it is", () => {
    const result: SessionRestoreResult = {
      outcome: "restore-finished",
      requested: "conversation-and-files",
      restored: "conversation-and-files",
    };
    expect(readRestoreResult(result, { kind: "snapshot", name: "API cleanup" })).toBe(
      "Restored to API cleanup",
    );
  });
});

describe("an undo where part went back", () => {
  it("names the conversation going back and the files not, with the daemon's cause", () => {
    const result: SessionRestoreResult = {
      outcome: "restore-finished",
      requested: "conversation-and-files",
      restored: "conversation",
      failures: { files: { reason: "The disk is full" } },
    };
    expect(readRestoreResult(result, MESSAGE)).toBe(
      "Restored to before Rename the config loader · files not restored · The disk is full",
    );
    expect(readRestoreResult(result, SNAPSHOT)).toBe(
      "Restored to before Rename the config loader · files not restored · The disk is full",
    );
  });

  it("names the files going back and the conversation not, with the daemon's cause", () => {
    const result: SessionRestoreResult = {
      outcome: "restore-finished",
      requested: "conversation-and-files",
      restored: "files",
      failures: { conversation: { reason: "Claude Code did not answer" } },
    };
    expect(readRestoreResult(result, MESSAGE)).toBe(
      "Files restored to before Rename the config loader · conversation not restored · Claude Code did not answer",
    );
    expect(readRestoreResult(result, SNAPSHOT)).toBe(
      "Files restored to before Rename the config loader · conversation not restored · Claude Code did not answer",
    );
  });

  it("refuses to draw a part that did not go back without the daemon's reason", () => {
    const result: SessionRestoreResult = {
      outcome: "restore-finished",
      requested: "conversation-and-files",
      restored: "conversation",
    };
    expect(() => readRestoreResult(result, MESSAGE)).toThrow(/files not restored/u);
  });
});

describe("an undo where nothing went back", () => {
  it("says the undo failed, with the daemon's cause", () => {
    const result: SessionRestoreResult = {
      outcome: "restore-finished",
      requested: "files",
      restored: "nothing",
      failures: { files: { reason: "Connection lost" } },
    };
    expect(readRestoreResult(result, MESSAGE)).toBe("Undo failed · Connection lost");
    expect(readRestoreResult(result, SNAPSHOT)).toBe("Undo failed · Connection lost");
  });

  it("names a cause both parts share once, and two different causes each", () => {
    const shared: SessionRestoreResult = {
      outcome: "restore-finished",
      requested: "conversation-and-files",
      restored: "nothing",
      failures: {
        conversation: { reason: "Connection lost" },
        files: { reason: "Connection lost" },
      },
    };
    expect(readRestoreResult(shared, MESSAGE)).toBe("Undo failed · Connection lost");

    const separate: SessionRestoreResult = {
      outcome: "restore-finished",
      requested: "conversation-and-files",
      restored: "nothing",
      failures: {
        conversation: { reason: "Claude Code did not answer" },
        files: { reason: "The disk is full" },
      },
    };
    expect(readRestoreResult(separate, MESSAGE)).toBe(
      "Undo failed · Claude Code did not answer · The disk is full",
    );
  });
});

describe("an edit and resend whose send failed after its undo applied", () => {
  it("says the undo went back and the resend failed, with the cause", () => {
    const result: SessionRestoreResult = { outcome: "resend-unapplied", reason: "Connection lost" };
    expect(readRestoreResult(result, MESSAGE)).toBe(
      "Restored to before Rename the config loader · resend failed · Connection lost",
    );
  });
});
