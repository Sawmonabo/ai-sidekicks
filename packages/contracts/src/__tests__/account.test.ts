// Deleting the hosted account acts on the caller's own account and takes no other
// account's id, so the request refuses any member at all.
import { describe, expect, it } from "vitest";

import { AccountDeleteRequestSchema } from "../account.js";

describe("account.delete", () => {
  it("deletes the caller's account and names no other", () => {
    expect(AccountDeleteRequestSchema.safeParse({}).success).toBe(true);
    expect(
      AccountDeleteRequestSchema.safeParse({ userId: "550e8400-e29b-41d4-a716-446655440000" })
        .success,
    ).toBe(false);
  });
});
