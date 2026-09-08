// The seed rule, on its own: a subject in hand is a question being put, and no subject
// is a question that cannot be.
//
// Asserted here rather than through a rendered surface because that is the whole of
// what this module decides. What happens to the value afterwards — which frame carries
// it, which settlement is admitted, what a re-address discards — belongs to
// `subject-scoped-holder.ts` and is proved against the holder itself. Three surfaces
// disagreed about the rule below in three different ways before it was written down
// once, and each of them now passes it in as the holder's `initial`.

import { describe, expect, it } from "vitest";

import { subjectReadStart } from "./subject-read-start.js";

describe("subjectReadStart — what a read starts as, given what it is about", () => {
  it("is reading the moment a subject is in scope", () => {
    // The defect this rule replaces: the three read hooks seeded `unasked` and moved to
    // `reading` from an effect, which runs after the commit — so one painted frame
    // claimed nobody had asked about a subject whose request was already out.
    expect(subjectReadStart("run-a")).toEqual({ status: "reading" });
  });

  it("negative control: an address with no subject stays unasked", () => {
    // Without this, the case above passes for a rule that answered `reading` to
    // everything — including an address with no question in it, where a spinner
    // promises an answer that is never coming.
    expect(subjectReadStart(undefined)).toEqual({ status: "unasked" });
  });

  it("negative control: the empty string is a subject, not an absence", () => {
    // A key is a NAME inside one object's key space, and the holder tells "no subject"
    // from a subject by `undefined` alone. A rule that treated a falsy id as no subject
    // would render a spinner-free empty region over a read it had in fact put.
    expect(subjectReadStart("")).toEqual({ status: "reading" });
  });
});
