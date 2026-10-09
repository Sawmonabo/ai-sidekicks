// Where the account-plane router sends a refusal, and where it sends none.

import { describe, expect, it } from "vitest";

import {
  PROVIDER_ACCOUNT_IN_USE_CODE,
  PROVIDER_ACCOUNT_NOT_REGISTERED_CODE,
} from "@ai-sidekicks/contracts/provider/account/methods";
import { PROVIDER_ACCOUNT_DISPLAY_LABEL_TAKEN_CODE } from "@ai-sidekicks/contracts/provider/account/sign-in";

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
    // Control: a code the contracts export is known, and a routed code reaches its page.
    expect(isAccountPlaneRefusalCode(PROVIDER_ACCOUNT_IN_USE_CODE)).toBe(true);
    // A taken name is known and answered under the field, never on a page.
    expect(isAccountPlaneRefusalCode(PROVIDER_ACCOUNT_DISPLAY_LABEL_TAKEN_CODE)).toBe(true);
    expect(accountPlaneHandoffFor(PROVIDER_ACCOUNT_DISPLAY_LABEL_TAKEN_CODE)).toBeUndefined();
    expect(accountPlaneHandoffFor(PROVIDER_ACCOUNT_NOT_REGISTERED_CODE)).toStrictEqual({
      section: "providers",
      remedyKind: "register",
    });
  });
});
