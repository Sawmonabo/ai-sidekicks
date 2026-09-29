// `repo-clone.ts`: cloning a repository and the clone card's live status.
import { describe, expect, it } from "vitest";

import {
  REPO_CLONE_LINE_MAX_LEN,
  RepoCloneAnswerRequestSchema,
  RepoCloneFolderReadResponseSchema,
  RepoCloneRequestSchema,
  RepoCloneStatusSchema,
} from "../repo-clone.js";

const PROJECT_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f20";
const CLONE_QUESTION_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f21";

describe("repo.clone and its card", () => {
  it("clones a URL into the clone folder, a chosen folder, or again for a project", () => {
    expect(
      RepoCloneRequestSchema.safeParse({ url: "https://github.com/acme/beacon.git" }).success,
    ).toBe(true);
    expect(
      RepoCloneRequestSchema.safeParse({
        url: "git@github.com:acme/beacon.git",
        parentFolder: "/Users/dev/code",
        projectId: PROJECT_ID,
      }).success,
    ).toBe(true);
    expect(RepoCloneRequestSchema.safeParse({ parentFolder: "/Users/dev/code" }).success).toBe(
      false,
    );
  });

  it("carries git's progress and its question while cloning", () => {
    expect(
      RepoCloneStatusSchema.safeParse({
        projectId: PROJECT_ID,
        state: "cloning",
        progress: { phase: "Receiving objects", percent: 42 },
        question: {
          questionId: CLONE_QUESTION_ID,
          prompt: "Password for 'https://github.com':",
          masked: true,
        },
      }).success,
    ).toBe(true);
    expect(
      RepoCloneStatusSchema.safeParse({
        projectId: PROJECT_ID,
        state: "cloning",
        progress: { phase: "Receiving objects", percent: 101 },
        question: null,
      }).success,
    ).toBe(false);
  });

  it("names the failed step and git's line, null only when git left none", () => {
    const failed = (failureLine: string | null) => ({
      projectId: PROJECT_ID,
      state: "failed",
      step: "clone",
      failureLine,
    });
    expect(
      RepoCloneStatusSchema.safeParse(failed("fatal: Authentication failed for 'https://…'"))
        .success,
    ).toBe(true);
    expect(RepoCloneStatusSchema.safeParse(failed(null)).success).toBe(true);
    expect(
      RepoCloneStatusSchema.safeParse(failed("x".repeat(REPO_CLONE_LINE_MAX_LEN + 1))).success,
    ).toBe(false);
    expect(
      RepoCloneStatusSchema.safeParse({ ...failed(null), progress: null, question: null }).success,
    ).toBe(false);
    expect(
      RepoCloneStatusSchema.safeParse({ projectId: PROJECT_ID, state: "paused" }).success,
    ).toBe(false);
  });

  it("passes an answer on one line, an empty one included, and refuses a line break or NUL", () => {
    const answer = (text: string) =>
      RepoCloneAnswerRequestSchema.safeParse({
        projectId: PROJECT_ID,
        questionId: CLONE_QUESTION_ID,
        answer: text,
      }).success;
    expect(answer("hunter2")).toBe(true);
    expect(answer("")).toBe(true);
    expect(answer("hunter2\nsecond")).toBe(false);
    expect(answer("hunter2\r")).toBe(false);
    expect(answer("hunter2\0")).toBe(false);
  });

  it("says where a clone goes and which rule chose the folder", () => {
    for (const source of ["setting", "lastProject", "home"]) {
      expect(
        RepoCloneFolderReadResponseSchema.safeParse({ folder: "/Users/dev/code", source }).success,
      ).toBe(true);
    }
    expect(
      RepoCloneFolderReadResponseSchema.safeParse({ folder: "/Users/dev/code", source: "recent" })
        .success,
    ).toBe(false);
  });
});
