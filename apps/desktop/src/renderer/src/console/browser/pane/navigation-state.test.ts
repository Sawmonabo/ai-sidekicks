// The address guard, and the one reading the chrome is allowed to derive from.
//
// The guard gets exhaustive cases because it has exactly one catastrophic failure and
// it is silent: a spelling it misses is a page navigated to a local file, which looks
// like a successful navigation to everything above it. So the cases are the FORMS
// rather than the concept — scheme, POSIX root, home shorthand, and the five Windows
// roots that are not one leading pair of backslashes (drive-absolute, drive-relative,
// bare drive, root-relative, UNC in either separator) — each with the whitespace a
// paste carries, and beside them the ordinary web destinations the field exists to
// accept, including the one that carries a colon of its own.

import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BROWSER_SCENARIO } from "../../bridge/scenarios/browser.js";
import { createFixtureBridge } from "../../bridge/index.js";
import { isFilesystemDestination, useReportedNavigation } from "./navigation-state.js";
import { refusalOf, reportedStateOf } from "./navigation-state.test-support.js";

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

describe("useReportedNavigation", () => {
  it("reports the port's refusal and no state, which is what the wire answers today", async () => {
    const bridge = createFixtureBridge({ scenario: BROWSER_SCENARIO });
    const { result } = renderHook(() => useReportedNavigation(bridge, "pane-browser-1"));
    await waitFor(() => {
      expect(refusalOf(result.current)).toBeDefined();
    });
    expect(refusalOf(result.current)?.code).toBe("wire-unregistered");
    // The half that matters to the chrome: no state means no navigability, so every
    // history control stays disabled rather than optimistically live.
    expect(reportedStateOf(result.current)).toBeUndefined();
  });

  it("starts with neither, so nothing renders a reading before one arrives", () => {
    const bridge = createFixtureBridge({ scenario: BROWSER_SCENARIO });
    const { result } = renderHook(() => useReportedNavigation(bridge, "pane-browser-1"));
    expect(result.current).toStrictEqual({ kind: "reading" });
  });
});
