// The id a removal's confirmation sends.

import { describe, expect, it } from "vitest";

import { rootRemovalSubjectFor } from "./root-removal-subject";

const WORKTREE_ID = "9f2c4a10-0000-4000-8000-000000000020";

describe("rootRemovalSubjectFor", () => {
  it("carries the id the act will send", () => {
    const subject = rootRemovalSubjectFor(WORKTREE_ID);
    expect(subject.rootId).toBe(WORKTREE_ID);
  });
});
