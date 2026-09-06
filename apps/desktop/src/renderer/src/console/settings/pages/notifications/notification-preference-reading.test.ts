// What this seam says when a preference write is refused.
//
// Every case here is about the CODE. A refusal renders its code verbatim, and a code
// nothing registers is a code no search finds and no person can act on: `rule 9`
// wants the refuser's own, and this module used to answer with the rejected value's
// JavaScript class name for every reachable producer.

import { describe, expect, it } from "vitest";

import {
  NOTIFICATION_PREFERENCE_REFUSAL_CODES,
  NOTIFICATION_PREFERENCE_REFUSAL_ORIGIN,
  rejectionRefusal,
} from "./notification-preference-reading.js";

/**
 * What the transport rejects with once the preference wire is live.
 *
 * `JsonRpcRemoteError` carries the JSON-RPC NUMERIC at `code` and the registered
 * dotted code at `data.type`, with the rate-limit bounds under `data.fields`. Built
 * as a plain error rather than imported, because what matters is the shape that
 * crosses the preload boundary and a class identity does not survive it.
 */
function jsonRpcRejection(): Error {
  const rejection = new Error("You may not change this session's preferences.");
  rejection.name = "JsonRpcRemoteError";
  Object.assign(rejection, {
    code: -32603,
    data: { type: "participant.permission_denied", fields: { retryAfter: 30 } },
  });
  return rejection;
}

describe("a refused preference write", () => {
  it("renders the daemon's own registered code, not the error class name", () => {
    const refusal = rejectionRefusal(jsonRpcRejection());

    expect(refusal.code).toBe("participant.permission_denied");
    expect(refusal.origin).toBe(NOTIFICATION_PREFERENCE_REFUSAL_ORIGIN);
    expect(refusal.detail).toBe("You may not change this session's preferences.");
  });

  it("never answers with the rejected value's class name", () => {
    // The negative control. The retired spelling flattened every rejection onto
    // `Error.name`, so this exact envelope rendered as
    // `notification-preferences: JsonRpcRemoteError: ...` for the pressed switch
    // and for every queued flip behind it.
    const refusal = rejectionRefusal(jsonRpcRejection());

    expect(refusal.code).not.toBe("JsonRpcRemoteError");
  });

  it("carries the retry bound the rate-limit envelope registered", () => {
    const refusal = rejectionRefusal(jsonRpcRejection());

    expect(refusal.retry).toStrictEqual({ afterSeconds: 30 });
  });

  it("falls back to this module's own code where the rejection carried none", () => {
    const refusal = rejectionRefusal(new Error("the socket closed"));

    expect(refusal.code).toBe(NOTIFICATION_PREFERENCE_REFUSAL_CODES[0]);
    expect(refusal.detail).toBe("This change was not saved.");
    expect(refusal.retry).toBeUndefined();
  });

  it("answers a refusal for a value that is not an error at all", () => {
    const refusal = rejectionRefusal(Object.create(null) as unknown);

    expect(refusal.origin).toBe(NOTIFICATION_PREFERENCE_REFUSAL_ORIGIN);
    expect(refusal.code).toBe(NOTIFICATION_PREFERENCE_REFUSAL_CODES[0]);
  });
});
