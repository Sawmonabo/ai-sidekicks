// The undo rows that report a failure: a part that did not go back, nothing going back, and a
// resend that failed after its undo applied. Read as a success, each would tell the person their
// files or message are where they are not.

import { describe, expect, it } from "vitest";
import type { SessionRestoreResult } from "@ai-sidekicks/contracts/session/restore";

import { readRestoreResult, type RestoreTarget } from "./restore-result-reading.js";

const MESSAGE: RestoreTarget = { kind: "message", firstWords: "Rename the config loader" };
const SNAPSHOT: RestoreTarget = { kind: "snapshot", name: "Nightly" };

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
      "Restored to nightly · files not restored · The disk is full",
    );
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
});

describe("an edit and resend whose send failed after its undo applied", () => {
  it("leads with the failed send and its cause, then says what went back", () => {
    const result: SessionRestoreResult = { outcome: "resend-unapplied", reason: "Connection lost" };
    expect(readRestoreResult(result, MESSAGE)).toBe(
      "Resend failed · Connection lost · restored to before Rename the config loader",
    );
    expect(readRestoreResult(result, SNAPSHOT)).toBe(
      "Resend failed · Connection lost · restored to nightly",
    );
  });
});
