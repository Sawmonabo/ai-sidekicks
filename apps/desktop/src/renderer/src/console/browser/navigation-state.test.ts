// The address guard, and the one reading the chrome is allowed to derive from.
//
// The guard gets exhaustive cases because it has exactly one catastrophic failure and
// it is silent: a spelling it misses is a page navigated to a local file, which looks
// like a successful navigation to everything above it. So the cases are the spellings
// rather than the concept — scheme, POSIX root, home shorthand, UNC share, drive
// letter, and each with the whitespace a paste carries — and the negative control is
// the ordinary web destination the field exists to accept.

import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BROWSER_SCENARIO } from "../bridge/scenarios/browser.js";
import { createFixtureBridge } from "../bridge/index.js";
import { isFilesystemDestination, useReportedNavigation } from "./navigation-state.js";

describe("isFilesystemDestination", () => {
  it("catches every spelling of a place on this machine", () => {
    const local = [
      "file:///etc/hosts",
      "FILE://C:/Windows",
      "/etc/hosts",
      "/",
      "~/Documents/report.pdf",
      "~",
      "\\\\share\\folder",
      "C:\\Windows\\System32",
      "c:/Windows",
    ];
    for (const destination of local) {
      expect(isFilesystemDestination(destination)).toBe(true);
    }
  });

  it("is not fooled by the whitespace a paste carries", () => {
    expect(isFilesystemDestination("  /etc/hosts  ")).toBe(true);
    expect(isFilesystemDestination("\tfile:///etc/hosts\n")).toBe(true);
  });

  it("negative control: an ordinary web destination passes", () => {
    // Without this, a guard that refused everything would satisfy every case above
    // and would also make the address field inert.
    for (const destination of [
      "https://example.invalid/page",
      "example.invalid",
      "http://localhost:5173/",
      "",
    ]) {
      expect(isFilesystemDestination(destination)).toBe(false);
    }
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
      expect(result.current.refusal).toBeDefined();
    });
    expect(result.current.refusal?.code).toBe("wire-unregistered");
    // The half that matters to the chrome: no state means no navigability, so every
    // history control stays disabled rather than optimistically live.
    expect(result.current.state).toBeUndefined();
  });

  it("starts with neither, so nothing renders a reading before one arrives", () => {
    const bridge = createFixtureBridge({ scenario: BROWSER_SCENARIO });
    const { result } = renderHook(() => useReportedNavigation(bridge, "pane-browser-1"));
    expect(result.current).toStrictEqual({ state: undefined, refusal: undefined });
  });
});
