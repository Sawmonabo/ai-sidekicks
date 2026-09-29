// The policy rows draw the positions the node reported and hand a toggle back by the
// console's own switch id.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { BrowserPolicySettings, type BrowserPolicySettingsProps } from "./BrowserPolicySettings.js";
import { BROWSER_POLICY_SWITCHES } from "../policy-switches.js";

function positions(
  fileBoundary: boolean,
  pageTools: boolean,
): BrowserPolicySettingsProps["positions"] {
  return { "file-boundary": fileBoundary, "page-tools": pageTools };
}

function renderPolicy(props: {
  readonly positions: BrowserPolicySettingsProps["positions"];
  readonly onToggle?: BrowserPolicySettingsProps["onToggle"];
}): HTMLElement {
  const { container } = render(
    <BrowserPolicySettings
      positions={props.positions}
      onToggle={props.onToggle ?? (() => undefined)}
    />,
  );
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
    const rows = renderPolicy({ positions: positions(false, true) });
    // Non-empty and exact: a count assertion alone would pass over a component
    // that rendered one row twice.
    expect(BROWSER_POLICY_SWITCHES).toHaveLength(2);
    expect(switchesIn(rows)).toHaveLength(BROWSER_POLICY_SWITCHES.length);
  });

  it("names every switch, so each control is reachable by name", () => {
    const rows = renderPolicy({ positions: positions(false, true) });
    for (const control of switchesIn(rows)) {
      const labelId = control.getAttribute("aria-labelledby");
      expect(labelId).not.toBeNull();
      expect(rows.querySelector(`#${String(labelId)}`)?.textContent ?? "").not.toBe("");
    }
  });

  it("says what each switch stops enforcing", () => {
    const text = renderPolicy({ positions: positions(false, true) }).textContent ?? "";
    expect(text).toContain("admitted root of a repo mount");
    expect(text).toContain("withholds the tools from every subsequent spawn");
    expect(text).toContain("Sessions already running keep the tool set");
  });
});

describe("browser policy rows — the position drawn", () => {
  it("draws the position the node reported", () => {
    const rows = renderPolicy({ positions: positions(true, false) });
    const [fileBoundary, pageTools] = switchesIn(rows);
    expect(fileBoundary?.getAttribute("aria-checked")).toBe("true");
    expect(pageTools?.getAttribute("aria-checked")).toBe("false");
  });

  it("hands the console-local id back on toggle, never a wire key", () => {
    const onToggle = vi.fn();
    const rows = renderPolicy({ positions: positions(false, false), onToggle });
    switchesIn(rows)[0]?.click();
    expect(onToggle).toHaveBeenCalledWith("file-boundary", true);
  });

  it("negative control: no main-process config key string reaches the screen", () => {
    // The preference keys are not the renderer's to name. A row that rendered one would
    // publish a wire vocabulary the renderer does not own.
    const text = renderPolicy({ positions: positions(false, true) }).textContent ?? "";
    expect(text).not.toContain("browser.");
    expect(text).not.toContain("shellConfig");
  });
});
