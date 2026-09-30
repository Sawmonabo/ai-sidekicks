// What may stand in the detail sentence: never the refused value, which may be user content. A
// rejection's members can be request values, paths or tokens, so no arm serializes it. Every case
// plants a request value the stringifier would disclose; without that, "the detail is the
// constant" would pass on a fixture with nothing to leak.

import { describe, expect, it } from "vitest";

import { lossyStringify, UNREPRESENTABLE_VALUE_TEXT } from "./wire-errors.js";
import { normalizeWireRejection } from "./wire-rejection.js";

describe("normalizeWireRejection — the detail is a sentence, never the rejection", () => {
  /**
   * What a malformed producer put on the wire beside a good code. `data.fields` legitimately holds
   * request values, and the `toString` is what a serializing arm would reach.
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
    // The whole answer, not only the sentence: no rejection member reaches the renderer.
    expect(JSON.stringify(refusal)).not.toContain(PLANTED_REQUEST_VALUE);
  });

  it("negative control: the fixture really discloses through the serializing arm", () => {
    // Proves the fixture really discloses through a serializing arm.
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
    // Same on the flat arm: the code is the one machine-readable thing that arrived.
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
    // Without this, an arm refusing every sentence would satisfy the cases above.
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
