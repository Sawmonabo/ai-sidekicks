// Which states are audit stubs, driven as a rule rather than through a rendered row.

import { describe, expect, it } from "vitest";

import { isAuditStubSession } from "./session-rows.js";

describe("audit stubs", () => {
  it("fails closed on a state it has never seen, and on none at all", () => {
    expect(isAuditStubSession("active")).toBe(false);
    expect(isAuditStubSession("something-new")).toBe(false);
    expect(isAuditStubSession(undefined)).toBe(false);
  });
});
