// The policy rows draw the positions the node reported and hand a toggle back by the
// console's own switch id.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { BrowserPolicySettings, type BrowserPolicySettingsProps } from "./BrowserPolicySettings.js";

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
});
