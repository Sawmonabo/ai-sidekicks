// Where the account-plane router sends a refusal, and where it sends none.

import { describe, expect, it } from "vitest";

import { accountPlaneHandoffFor, isAccountPlaneRefusalCode } from "./account-plane-handoff.js";

describe("the account-plane router", () => {
  it("answers nothing for another namespace's code, or a code no console act closes", () => {
    // Negative control: the router takes a bare wire string, so a neighboring namespace must not
    // fall through into a Providers handoff.
    expect(isAccountPlaneRefusalCode("driver.capability_unsupported")).toBe(false);
    expect(accountPlaneHandoffFor("driver.capability_unsupported")).toBeUndefined();
    expect(accountPlaneHandoffFor("")).toBeUndefined();
    // A refusal about the caller's authority is not routed to a page that would change nothing.
    expect(accountPlaneHandoffFor("provideraccount.permission_denied")).toBeUndefined();
    expect(accountPlaneHandoffFor("provideraccount.provider_version_below_floor")).toBeUndefined();
  });

  it("routes the three admission refusals to the acts that close them", () => {
    expect(accountPlaneHandoffFor("provideraccount.not_registered")).toStrictEqual({
      section: "providers",
      remedyKind: "register",
    });
    expect(accountPlaneHandoffFor("provideraccount.no_default")).toStrictEqual({
      section: "providers",
      remedyKind: "choose_default",
    });
    expect(accountPlaneHandoffFor("provideraccount.not_authenticated")).toStrictEqual({
      section: "providers",
      remedyKind: "sign_in",
    });
  });
});
