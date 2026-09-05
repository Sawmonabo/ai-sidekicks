// Which of the two states the field is in, and what each one shows.
//
// The claims are about the state the field is NOT in as much as the one it is: the
// defect this model replaces was a single string, which is indistinguishable from an
// editing state that nothing ever leaves. So every case names the reported URL and
// the state together, and the control is the one a single string could not produce —
// a reported navigation moving the field while nobody is typing.

import { describe, expect, it } from "vitest";

import {
  addressFieldSubmission,
  addressFieldValue,
  editingAddressField,
  FOLLOWING_ADDRESS_FIELD,
} from "./address-field-model.js";

const REPORTED = "https://example.invalid/page";
const REDIRECTED = "https://example.invalid/after-redirect";

describe("addressFieldValue", () => {
  it("follows the reported URL while nobody is editing", () => {
    expect(addressFieldValue(FOLLOWING_ADDRESS_FIELD, REPORTED)).toBe(REPORTED);
  });

  it("follows a redirect, which is the case a submitted string masks forever", () => {
    // The reported URL is the only input that changed. A field holding what was
    // submitted would still be showing the pre-redirect destination here, and
    // submitting again would go back to it.
    expect(addressFieldValue(FOLLOWING_ADDRESS_FIELD, REDIRECTED)).toBe(REDIRECTED);
  });

  it("shows nothing rather than a fabricated URL before any reading arrives", () => {
    expect(addressFieldValue(FOLLOWING_ADDRESS_FIELD, undefined)).toBe("");
  });

  it("holds the draft while editing, so a navigation cannot move the caret", () => {
    const editing = editingAddressField("https://example.invalid/half-typ");
    expect(addressFieldValue(editing, REDIRECTED)).toBe("https://example.invalid/half-typ");
  });

  it("holds an emptied draft, which is an edit and not an absent reading", () => {
    // The one case where editing and following would agree if the model were a
    // string: a person who cleared the field is not a pane with nothing reported.
    expect(addressFieldValue(editingAddressField(""), REPORTED)).toBe("");
  });

  it("negative control: leaving the edit puts the reported URL back", () => {
    // Without this, a model that never left editing would satisfy every case above
    // and would be the exact defect this one replaces.
    expect(addressFieldValue(editingAddressField("typed"), REPORTED)).toBe("typed");
    expect(addressFieldValue(FOLLOWING_ADDRESS_FIELD, REPORTED)).toBe(REPORTED);
  });
});

describe("addressFieldSubmission", () => {
  it("sends the draft the person typed, without the whitespace a paste carries", () => {
    expect(addressFieldSubmission(editingAddressField("  example.invalid  "), undefined)).toBe(
      "example.invalid",
    );
  });

  it("sends the reported URL when nothing was typed, which is a reload by hand", () => {
    expect(addressFieldSubmission(FOLLOWING_ADDRESS_FIELD, REPORTED)).toBe(REPORTED);
  });

  it("sends nothing when there is nothing to send", () => {
    expect(addressFieldSubmission(FOLLOWING_ADDRESS_FIELD, undefined)).toBe("");
  });

  it("negative control: it is the field's own value and never a second reading", () => {
    // The guard and the navigation both read this, and a submission that disagreed
    // with what the field showed is how a refused destination reaches the wire.
    const editing = editingAddressField(" /etc/hosts ");
    expect(addressFieldSubmission(editing, REPORTED)).toBe(
      addressFieldValue(editing, REPORTED).trim(),
    );
  });
});
