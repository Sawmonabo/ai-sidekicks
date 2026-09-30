// The address guard gets exhaustive cases because its one failure is silent: a missed spelling
// navigates a page to a local file. The cases are the forms (scheme, POSIX root, home shorthand,
// the Windows roots), each with the whitespace a paste carries, beside the web destinations the
// field must accept, including one that carries a colon of its own.

import { describe, expect, it } from "vitest";

import { isFileAddress } from "./address-field-model.js";

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
});
