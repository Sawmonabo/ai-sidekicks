// The defect this model replaces was a single string, indistinguishable from an editing state
// that nothing ever leaves. Each case names the reported URL and the state together; the control
// is a reported navigation moving the field while nobody is typing.

import { describe, expect, it } from "vitest";

import {
  addressFieldSubmission,
  addressFieldValue,
  editingAddressField,
  FOLLOWING_ADDRESS_FIELD,
  isFileAddress,
} from "./address-field-model.js";

const REPORTED = "https://example.invalid/page";
const REDIRECTED = "https://example.invalid/after-redirect";

describe("addressFieldValue", () => {
  it("follows the reported URL while nobody is editing", () => {
    expect(addressFieldValue(FOLLOWING_ADDRESS_FIELD, REPORTED)).toBe(REPORTED);
  });

  it("follows a redirect, which is the case a submitted string masks forever", () => {
    // Only the reported URL changed. A field holding the submitted string would still show the
    // pre-redirect destination, and submitting again would go back to it.
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
    // A person who cleared the field is not a pane with nothing reported.
    expect(addressFieldValue(editingAddressField(""), REPORTED)).toBe("");
  });

  it("negative control: leaving the edit puts the reported URL back", () => {
    // Without this, a model that never left editing would satisfy every case above.
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
    // A submission that disagreed with what the field showed is how a refused destination
    // reaches the wire.
    const editing = editingAddressField(" /etc/hosts ");
    expect(addressFieldSubmission(editing, REPORTED)).toBe(
      addressFieldValue(editing, REPORTED).trim(),
    );
  });
});

// The address guard gets exhaustive cases because its one failure is silent: a missed spelling
// navigates a page to a local file. The cases are the forms (scheme, POSIX root, home shorthand,
// the Windows roots), each with the whitespace a paste carries, beside the web destinations the
// field must accept, including one that carries a colon of its own.

/**
 * Every local-path spelling, named by its form and paired with the verdict the field owes it.
 * The false rows sit in the same table so that a widening which refuses ordinary web
 * destinations fails where the two are compared.
 */
const DESTINATION_FORMS: readonly {
  readonly form: string;
  readonly destination: string;
  readonly isLocal: boolean;
}[] = [
  { form: "file scheme", destination: "file:///etc/hosts", isLocal: true },
  {
    form: "file scheme, upper case, naming a drive",
    destination: "FILE://C:/Windows",
    isLocal: true,
  },
  { form: "POSIX absolute", destination: "/etc/hosts", isLocal: true },
  { form: "POSIX root itself", destination: "/", isLocal: true },
  { form: "home shorthand", destination: "~/Documents/report.pdf", isLocal: true },
  { form: "home itself", destination: "~", isLocal: true },
  {
    form: "Windows drive-absolute, backslash",
    destination: "C:\\Windows\\System32",
    isLocal: true,
  },
  { form: "Windows drive-absolute, forward slash", destination: "c:/Windows", isLocal: true },
  { form: "Windows drive-relative", destination: "C:secret.txt", isLocal: true },
  { form: "Windows bare drive", destination: "D:", isLocal: true },
  { form: "Windows root-relative", destination: "\\Windows\\System32", isLocal: true },
  { form: "Windows root-relative, forward slash", destination: "/Windows/System32", isLocal: true },
  { form: "UNC share, backslash", destination: "\\\\server\\share\\secret.txt", isLocal: true },
  { form: "UNC share, forward slash", destination: "//server/share/secret.txt", isLocal: true },
  { form: "Windows extended-length prefix", destination: "\\\\?\\C:\\secret.txt", isLocal: true },
  { form: "Windows device namespace", destination: "\\\\.\\pipe\\name", isLocal: true },
  { form: "https destination", destination: "https://example.invalid/page", isLocal: false },
  { form: "bare host", destination: "example.invalid", isLocal: false },
  {
    form: "host and port, which also carries a colon",
    destination: "example.invalid:8443/page",
    isLocal: false,
  },
  { form: "loopback with a port", destination: "http://localhost:5173/", isLocal: false },
  { form: "empty field", destination: "", isLocal: false },
];

describe("isFileAddress", () => {
  it.each(DESTINATION_FORMS)("$form", ({ destination, isLocal }) => {
    expect(isFileAddress(destination)).toBe(isLocal);
  });

  it("is not fooled by the whitespace a paste carries", () => {
    expect(isFileAddress("  /etc/hosts  ")).toBe(true);
    expect(isFileAddress("\tfile:///etc/hosts\n")).toBe(true);
  });

  it("negative control: the table admits as well as refuses", () => {
    // Without this, a guard that refused everything would satisfy every true row and make the
    // address field inert.
    expect(DESTINATION_FORMS.filter((row) => !row.isLocal).length).toBeGreaterThan(0);
    expect(DESTINATION_FORMS.some((row) => row.isLocal)).toBe(true);
  });

  it("does not mistake a scheme that merely starts with the same letters", () => {
    expect(isFileAddress("filesystem-notes.example.invalid")).toBe(false);
  });
});
