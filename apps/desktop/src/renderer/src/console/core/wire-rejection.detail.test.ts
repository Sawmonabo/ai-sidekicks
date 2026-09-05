// What may stand in the detail sentence, and what may never.
//
// `core/refusal.ts` states the rule: a refusal's `detail` is "never the refused value
// itself, which may be participant content". A rejection off the bridge is `unknown`
// and its members are request values, repository paths, headers, or a token as easily
// as they are prose — and the arm that had a code but no readable sentence used to
// answer by serializing the whole rejection into that field.
//
// Its own file rather than a fourth block in `wire-rejection.test.ts`, on the seam
// that file's header already draws: the claims there are which CODE survives and
// whether the function is total, and this one is about the other half of the answer.
//
// The negative control here is the fixture rather than a probe: every case plants a
// request value the rejection really discloses through the stringifier the arms used
// to reach for, and one case asserts that disclosure directly — without it, "the
// detail is the constant" would also be satisfied by a fixture with nothing to leak.

import { describe, expect, it } from "vitest";

import { lossyStringify, UNREPRESENTABLE_VALUE_TEXT } from "../../../../shared/wire-errors.js";
import { normalizeWireRejection } from "./wire-rejection.js";

describe("normalizeWireRejection — the detail is a sentence, never the rejection", () => {
  /**
   * What a malformed producer put on the wire beside a perfectly good code.
   *
   * `error-contracts.md §Rate Limiting` puts request values in `data.fields` by
   * design, so this is the ordinary content of the envelope rather than a contrived
   * one; the `toString` is what a serializing arm reaches, and it is the reason a
   * plain-object claim about `[object Object]` does not bound the disclosure.
   */
  const PLANTED_REQUEST_VALUE = "/Users/someone/private-notes";

  /** A JSON-RPC envelope carrying a dotted code, no readable sentence, and content. */
  function envelopeCarryingContent(): unknown {
    return {
      code: -32603,
      message: { notAString: true },
      data: { type: "repo.not_found", fields: { path: PLANTED_REQUEST_VALUE } },
      toString(): string {
        return `repo read failed for ${PLANTED_REQUEST_VALUE}`;
      },
    };
  }

  it("keeps the dotted code and renders the constant rather than the envelope", () => {
    const refusal = normalizeWireRejection("repos", envelopeCarryingContent());
    expect(refusal.code).toBe("repo.not_found");
    expect(refusal.detail).toBe(UNREPRESENTABLE_VALUE_TEXT);
    // The whole answer, not only the sentence: no member of the rejection reaches
    // the renderer by any route, including the code the retry hint was read from.
    expect(JSON.stringify(refusal)).not.toContain(PLANTED_REQUEST_VALUE);
  });

  it("negative control: the fixture really discloses through the serializing arm", () => {
    // The exact expression this module used to evaluate on this exact value. Without
    // it, "the detail is the constant" would also be satisfied by a fixture that had
    // nothing to leak.
    expect(lossyStringify(envelopeCarryingContent())).toContain(PLANTED_REQUEST_VALUE);
  });

  it("prefers the caller's own sentence over the constant, and still keeps the code", () => {
    const refusal = normalizeWireRejection("repos", envelopeCarryingContent(), {
      code: "repo-read-failed",
      detail: "The repository read never answered.",
    });
    expect(refusal.code).toBe("repo.not_found");
    expect(refusal.detail).toBe("The repository read never answered.");
  });

  it("keeps a FLAT envelope's code where its message is unreadable too", () => {
    // The same defect on the other wire arm: the code was the one machine-readable
    // thing that arrived, and answering with `repos-call-failed` threw it away.
    const refusal = normalizeWireRejection("repos", { code: "repo.locked", message: 7 });
    expect(refusal.code).toBe("repo.locked");
    expect(refusal.detail).toBe(UNREPRESENTABLE_VALUE_TEXT);
  });

  it("refuses to serialize a structure on the terminal arm either", () => {
    const rejection = {
      requestedPath: PLANTED_REQUEST_VALUE,
      toString(): string {
        return `the call failed for ${PLANTED_REQUEST_VALUE}`;
      },
    };
    const refusal = normalizeWireRejection("repos", rejection);
    expect(refusal.code).toBe("repos-call-failed");
    expect(refusal.detail).toBe(UNREPRESENTABLE_VALUE_TEXT);
  });

  it("negative control: prose a producer wrote still reaches the detail", () => {
    // Without this, "the detail is the constant" would be satisfied by an arm that
    // refused every sentence — which would leave every failure on screen unreadable.
    expect(normalizeWireRejection("repos", new Error("The mount is gone.")).detail).toBe(
      "The mount is gone.",
    );
    expect(normalizeWireRejection("repos", "the socket closed").detail).toBe("the socket closed");
    expect(
      normalizeWireRejection("repos", { code: "repo.locked", message: "Another node holds it." })
        .detail,
    ).toBe("Another node holds it.");
  });
});
