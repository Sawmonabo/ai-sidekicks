// A copy's progress while one large file copies: each tick counts what has reached the
// destination so far, so the row moves before the file is done, and the tick stops at the end.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectIdSchema } from "@ai-sidekicks/contracts/project";
import { WorktreeIdSchema } from "@ai-sidekicks/contracts/worktree/lifecycle";

import { mintUuidV7 } from "../../../uuid-v7.js";
import { WorktreeCopiesUnderWay } from "../copy-progress.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a copy across volumes of one large file", () => {
  it("reports the bytes written so far four times a second, and nothing once it ends", async () => {
    const copies = new WorktreeCopiesUnderWay({
      writeServiceLog: (line) => {
        throw new Error(`unexpected service log line: ${line}`);
      },
    });
    const copiedFigures: number[] = [];
    copies.follow(undefined, (progress) => {
      copiedFigures.push(...progress.copies.map((copy) => copy.copiedBytes));
    });
    // The destination of the one file grows by 300 bytes between reads.
    let reads = 0;
    const readBytesInFlight = (): Promise<number> => {
      reads += 1;
      return Promise.resolve(reads * 300);
    };

    const report = copies.begin(
      {
        kind: "removing",
        worktreeId: WorktreeIdSchema.parse(mintUuidV7()),
        projectId: ProjectIdSchema.parse(mintUuidV7()),
        name: "large-file",
      },
      1000,
      readBytesInFlight,
    );
    await vi.advanceTimersByTimeAsync(750);
    expect(copiedFigures).toEqual([0, 300, 600, 900]);

    report.addCopied(1000);
    report.end();
    await vi.advanceTimersByTimeAsync(1000);
    expect(reads).toBe(3);
  });
});
