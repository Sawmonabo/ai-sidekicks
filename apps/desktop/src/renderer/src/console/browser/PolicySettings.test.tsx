// The policy rows say two things at once, and the tests hold both apart.
//
// A row whose reading is absent draws the ENFORCING position and says the position
// is not a reading. Either half alone is a defect: the position alone asserts a fact
// nobody established, and the notice alone leaves a permissive control drawn under
// it. So every clean case here has a negative control that would pass if the row
// collapsed the two.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { refuse } from "../core/index.js";
import {
  BROWSER_POLICY_SWITCHES,
  BrowserPolicySettings,
  type BrowserPolicySettingsProps,
} from "./PolicySettings.js";

const UNREAD_REFUSAL = refuse(
  "growth-port",
  "wire-unregistered",
  "Not checked — the shell-config preference carrier is not registered yet.",
);

function bothRead(
  fileBoundary: boolean,
  pageTools: boolean,
): BrowserPolicySettingsProps["readings"] {
  return {
    "file-boundary": { status: "read", enabled: fileBoundary },
    "page-tools": { status: "read", enabled: pageTools },
  };
}

function renderPolicy(props: BrowserPolicySettingsProps): HTMLElement {
  const { container } = render(<BrowserPolicySettings {...props} />);
  const list = container.querySelector("ul");
  if (!(list instanceof HTMLElement)) {
    throw new Error("BrowserPolicySettings rendered no list");
  }
  return list;
}

function switchesIn(root: HTMLElement): readonly HTMLElement[] {
  return [...root.querySelectorAll('[role="switch"]')].filter(
    (node): node is HTMLElement => node instanceof HTMLElement,
  );
}

describe("browser policy rows — the closed pair", () => {
  it("renders exactly the switches the set declares", () => {
    const rows = renderPolicy({ readings: bothRead(false, true) });
    // Non-empty and exact: a count assertion alone would pass over a component
    // that rendered one row twice.
    expect(BROWSER_POLICY_SWITCHES).toHaveLength(2);
    expect(switchesIn(rows)).toHaveLength(BROWSER_POLICY_SWITCHES.length);
  });

  it("names every switch, so each control is reachable by name", () => {
    const rows = renderPolicy({ readings: bothRead(false, true) });
    for (const control of switchesIn(rows)) {
      const labelId = control.getAttribute("aria-labelledby");
      expect(labelId).not.toBeNull();
      expect(rows.querySelector(`#${String(labelId)}`)?.textContent ?? "").not.toBe("");
    }
  });

  it("says what each switch stops enforcing", () => {
    const text = renderPolicy({ readings: bothRead(false, true) }).textContent ?? "";
    expect(text).toContain("admitted root of a repo mount");
    expect(text).toContain("withholds the tools from every subsequent spawn");
    expect(text).toContain("Sessions already running keep the tool set");
  });
});

describe("browser policy rows — a reading, drawn", () => {
  it("draws the position the node reported", () => {
    const rows = renderPolicy({ readings: bothRead(true, false), onToggle: () => undefined });
    const [fileBoundary, pageTools] = switchesIn(rows);
    expect(fileBoundary?.getAttribute("aria-checked")).toBe("true");
    expect(pageTools?.getAttribute("aria-checked")).toBe("false");
  });

  it("hands the console-local id back on toggle, never a wire key", () => {
    const onToggle = vi.fn();
    const rows = renderPolicy({ readings: bothRead(false, false), onToggle });
    switchesIn(rows)[0]?.click();
    expect(onToggle).toHaveBeenCalledWith("file-boundary", true);
  });

  it("renders read-only, and says so, when no writer is registered", () => {
    const rows = renderPolicy({ readings: bothRead(false, true) });
    for (const control of switchesIn(rows)) {
      expect(
        control.getAttribute("aria-disabled") ?? control.getAttribute("disabled"),
      ).not.toBeNull();
    }
    expect(rows.textContent ?? "").toContain("Read-only");
  });
});

describe("browser policy rows — an absent reading", () => {
  const unread: BrowserPolicySettingsProps["readings"] = {
    "file-boundary": { status: "unread", refusal: UNREAD_REFUSAL },
    "page-tools": { status: "unread", refusal: UNREAD_REFUSAL },
  };

  it("draws the enforcing position", () => {
    for (const control of switchesIn(
      renderPolicy({ readings: unread, onToggle: () => undefined }),
    )) {
      expect(control.getAttribute("aria-checked")).toBe("false");
    }
  });

  it("says the position is not a reading, and renders the daemon's own refusal", () => {
    const text = renderPolicy({ readings: unread }).textContent ?? "";
    expect(text).toContain("Not read");
    expect(text).toContain("wire-unregistered");
    expect(text).toContain("is not registered yet");
  });

  it("offers no toggle even when a writer exists", () => {
    const onToggle = vi.fn();
    const rows = renderPolicy({ readings: unread, onToggle });
    switchesIn(rows)[0]?.click();
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("negative control: an unread row is not rendered as a plain off reading", () => {
    // Every case above would pass over a component that drew `false` and said
    // nothing — which is the exact conflation rule 8 forbids. This case fails on
    // that component and passes only on one that carries the notice as well.
    const readOff = renderPolicy({ readings: bothRead(false, false) }).textContent ?? "";
    expect(readOff).not.toContain("Not read");
    const unreadText = renderPolicy({ readings: unread }).textContent ?? "";
    expect(unreadText).toContain("Not read");
  });

  it("negative control: no shell-config key string reaches the screen", () => {
    // The preference keys are unregistered. A row that rendered one would be
    // publishing a wire vocabulary the corpus has not minted.
    const text = renderPolicy({ readings: unread }).textContent ?? "";
    expect(text).not.toContain("browser.");
    expect(text).not.toContain("shellConfig");
  });
});
