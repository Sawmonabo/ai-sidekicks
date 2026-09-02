// What a prepared proposal is allowed to say, held against the rules it was written
// from.
//
// The cases drive the real function and the real tables rather than stand-ins, and each
// clean assertion is paired with the case that would pass if the module stopped doing
// the thing — a totality claim is only meaningful beside the key that must not be in
// the table, and "inert display data" is only meaningful beside the value that would
// have arrived as something other than a string.

import { describe, expect, it } from "vitest";

import {
  PROPOSAL_BLOB_UNRENDERABLE,
  PROPOSAL_MEMBERS_NOT_ON_THE_WIRE,
  PROPOSAL_MEMBER_UNSUPPLIED_COPY,
  PROPOSAL_STATES,
  proposalBlobRows,
} from "./prepared-proposal.js";

describe("the proposal vocabularies — declared once, and closed where the wire closes them", () => {
  it("negative control: the proposal state vocabulary is the wire's own two words and no host verdict", () => {
    // A tuple can hold two of the wrong members, so the members themselves are
    // asserted — and a host-side state leaking in here would let the gate report a
    // proposal as open or merged before anything reached a host.
    expect([...PROPOSAL_STATES]).toStrictEqual(["draft", "ready"]);
    expect([...PROPOSAL_STATES]).not.toContain("open");
  });

  it("gives every unsupplied proposal member a sentence, and no key beyond them", () => {
    expect(Object.keys(PROPOSAL_MEMBER_UNSUPPLIED_COPY).sort()).toStrictEqual(
      [...PROPOSAL_MEMBERS_NOT_ON_THE_WIRE].sort(),
    );
  });
});

describe("proposalBlobRows — inert display data, never instructions", () => {
  it("renders every value as a string, whatever the producer sent", () => {
    const rows = proposalBlobRows({
      draft: false,
      labels: ["needs-review"],
      reviewers: { requested: 2 },
      title: "Wire the rate limiter",
    });
    for (const row of rows) {
      expect(typeof row.text).toBe("string");
    }
    expect(rows.map((row) => row.key)).toStrictEqual(["draft", "labels", "reviewers", "title"]);
  });

  it("passes a string value through verbatim rather than re-encoding it", () => {
    const rows = proposalBlobRows({ title: "Wire the rate limiter" });
    expect(rows[0]?.text).toBe("Wire the rate limiter");
  });

  it("sorts keys so two reads of one proposal draw the same rows", () => {
    const forward = proposalBlobRows({ alpha: 1, beta: 2 });
    const reversed = proposalBlobRows({ beta: 2, alpha: 1 });
    expect(forward).toStrictEqual(reversed);
  });

  it("states the fallback for a value that will not stringify", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(proposalBlobRows({ handler: () => undefined, ...cyclic })).toStrictEqual([
      { key: "handler", text: PROPOSAL_BLOB_UNRENDERABLE },
      { key: "self", text: PROPOSAL_BLOB_UNRENDERABLE },
    ]);
  });

  it("negative control: a key the console might act on arrives as text like every other", () => {
    // The whole point of the stringification. A caller cannot branch on a blob's
    // shape, so a key named for an act reaches the screen as the text of its value.
    const rows = proposalBlobRows({ action: { merge: true }, __html: "<script>" });
    expect(rows).toStrictEqual([
      { key: "__html", text: "<script>" },
      { key: "action", text: '{"merge":true}' },
    ]);
    for (const row of rows) {
      expect(typeof row.text).toBe("string");
    }
  });

  it("negative control: an absent blob is no rows rather than a row saying so", () => {
    expect(proposalBlobRows(undefined)).toStrictEqual([]);
  });
});
