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
  isFilesystemDestination,
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

// THE ADDRESS GUARD gets exhaustive cases because it has exactly one catastrophic failure and
// it is silent: a spelling it misses is a page navigated to a local file, which looks
// like a successful navigation to everything above it. So the cases are the FORMS
// rather than the concept — scheme, POSIX root, home shorthand, and the five Windows
// roots that are not one leading pair of backslashes (drive-absolute, drive-relative,
// bare drive, root-relative, UNC in either separator) — each with the whitespace a
// paste carries, and beside them the ordinary web destinations the field exists to
// accept, including the one that carries a colon of its own.

/**
 * Every local-path spelling, named by its FORM and paired with the verdict the
 * address field owes it.
 *
 * A table keyed by form rather than a list of examples, because the forms are what
 * differ between platforms and a list invites the reader to check the ones that look
 * alike. The Windows rows are the reason the table exists: a drive-relative
 * `C:secret.txt` and a root-relative `\\Windows\\System32` carry neither the separator
 * after the colon nor the doubled leading backslash an earlier reading required, so
 * both were dispatched as web destinations.
 *
 * The false rows sit in the same table rather than in a control of their own so that
 * a widening which starts refusing ordinary web destinations fails here, in the place
 * a reader compares the two against each other.
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

describe("isFilesystemDestination", () => {
  it.each(DESTINATION_FORMS)("$form", ({ destination, isLocal }) => {
    expect(isFilesystemDestination(destination)).toBe(isLocal);
  });

  it("is not fooled by the whitespace a paste carries", () => {
    expect(isFilesystemDestination("  /etc/hosts  ")).toBe(true);
    expect(isFilesystemDestination("\tfile:///etc/hosts\n")).toBe(true);
  });

  it("negative control: the table admits as well as refuses", () => {
    // Without this, a guard that refused EVERYTHING would satisfy every true row
    // above and would also make the address field inert — and a table read row by
    // row is exactly where that goes unnoticed.
    expect(DESTINATION_FORMS.filter((row) => !row.isLocal).length).toBeGreaterThan(0);
    expect(DESTINATION_FORMS.some((row) => row.isLocal)).toBe(true);
  });

  it("does not mistake a scheme that merely starts with the same letters", () => {
    expect(isFilesystemDestination("filesystem-notes.example.invalid")).toBe(false);
  });
});
