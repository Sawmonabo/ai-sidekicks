// The remedy and the keychain cause an account-plane refusal names reach the page from either
// envelope the wire refuses in, while nothing else the envelope carried does.

import { describe, expect, it } from "vitest";

import { PROVIDER_ACCOUNT_NOT_AUTHENTICATED_CODE } from "@ai-sidekicks/contracts/provider/account/methods";
import { PROVIDER_ACCOUNT_CREDENTIAL_SEAL_REFUSED_CODE } from "@ai-sidekicks/contracts/provider/account/sign-in";

import { normalizeWireRejection } from "@renderer/lib/wire-rejection.js";
import {
  readCarriedLoginRemedy,
  readKeychainRefusalCause,
} from "./provider-account-refusal-details.js";

/** A request value a producer put beside the named members, which must never travel. */
const PLANTED_REQUEST_VALUE = "/Users/someone/private-notes";

const REMEDY = { kind: "paste_token", accountId: "pa-0003" } as const;

describe("account-plane refusal details", () => {
  it("reads the named remedy and cause off both envelopes, and nothing beside them", () => {
    const jsonRpc = normalizeWireRejection("providers", {
      code: -32603,
      message: "That account is not signed in.",
      data: {
        type: PROVIDER_ACCOUNT_NOT_AUTHENTICATED_CODE,
        fields: { remedy: { ...REMEDY, path: PLANTED_REQUEST_VALUE }, path: PLANTED_REQUEST_VALUE },
      },
    });
    const flat = normalizeWireRejection("providers", {
      code: PROVIDER_ACCOUNT_CREDENTIAL_SEAL_REFUSED_CODE,
      message: "The token was not stored.",
      details: { cause: "locked", path: PLANTED_REQUEST_VALUE },
    });

    expect(readCarriedLoginRemedy(jsonRpc)).toStrictEqual(REMEDY);
    expect(readKeychainRefusalCause(flat)).toBe("locked");
    // Each reader answers only for its own code, so one refusal's members never speak for another.
    expect(readKeychainRefusalCause(jsonRpc)).toBeUndefined();
    expect(readCarriedLoginRemedy(flat)).toBeUndefined();
    // A member beside the named ones can be a request value, so the whole refusal is checked.
    expect(JSON.stringify(jsonRpc)).not.toContain(PLANTED_REQUEST_VALUE);
    expect(JSON.stringify(flat)).not.toContain(PLANTED_REQUEST_VALUE);
  });
});
