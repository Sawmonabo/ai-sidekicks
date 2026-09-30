// The seed rule on its own: a subject in hand is a question being put, and no subject is a
// question that cannot be. What happens to the value afterwards belongs to the holder in
// `lib/subject-scoped/subject-scoped-holder.ts`.

import { describe, expect, it } from "vitest";

import { subjectReadStart } from "./subject-read-start.js";

describe("subjectReadStart — what a read starts as, given what it is about", () => {
  it("is reading the moment a subject is in scope", () => {
    // Seeding `unasked` and moving to `reading` in an effect paints a frame claiming nobody asked.
    expect(subjectReadStart("run-a")).toEqual({ status: "reading" });
  });

  it("negative control: an address with no subject stays unasked", () => {
    // Without this, the case above passes for a rule that answered `reading` to everything.
    expect(subjectReadStart(undefined)).toEqual({ status: "unasked" });
  });

  it("negative control: the empty string is a subject, not an absence", () => {
    // The holder tells "no subject" from a subject by `undefined` alone; a falsy id is a subject.
    expect(subjectReadStart("")).toEqual({ status: "reading" });
  });
});
