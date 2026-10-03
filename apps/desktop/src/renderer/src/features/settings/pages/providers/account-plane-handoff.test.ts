// Where the account-plane router sends a refusal, and where it sends none.

import { describe, expect, it } from "vitest";

import { accountPlaneHandoffFor, isAccountPlaneRefusalCode } from "./account-plane-handoff.js";

describe("the account-plane router", () => {
  it("answers nothing for another namespace's code, or a code no app act closes", () => {
    // Negative control: the router takes a bare wire string, so a neighboring namespace must not
    // fall through into a Providers handoff.
    expect(isAccountPlaneRefusalCode("driver.capability_unsupported")).toBe(false);
    expect(accountPlaneHandoffFor("driver.capability_unsupported")).toBeUndefined();
    expect(accountPlaneHandoffFor("")).toBeUndefined();
    // A session asking for an account verb is not routed to a page that would change nothing.
    expect(accountPlaneHandoffFor("provideraccount.permission_denied")).toBeUndefined();
  });
});
