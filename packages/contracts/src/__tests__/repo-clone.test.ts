// An answer to git's question during a clone reaches git through its askpass program, which prints
// it as one line, so a line break or NUL would cut the answer short or smuggle in a second.
import { describe, expect, it } from "vitest";

import { RepoCloneAnswerRequestSchema } from "../repo-clone.js";

const PROJECT_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f20";
const CLONE_QUESTION_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f21";

describe("repo.cloneAnswer", () => {
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
});
