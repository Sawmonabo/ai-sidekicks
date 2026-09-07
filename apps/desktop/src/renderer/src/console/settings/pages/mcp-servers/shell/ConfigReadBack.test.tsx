// The configuration read-back, driven against the arguments the daemon serves.
//
// THE ARGUMENTS DECIDE WHAT THE COMMAND DOES. `--read-only` and `--allow-write` are
// the same command and opposite grants, so a read-back that reported their COUNT told
// an operator that two bindings were identical when one of them could write. They are
// already part of the redacted view the daemon serves — the wire carries the strings —
// so nothing is being disclosed here that was withheld.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { GrowthMcpInventoryEntry } from "../../../../bridge/index.js";
import { ConfigReadBack } from "./ConfigReadBack.js";

afterEach(() => {
  cleanup();
});

/** Indexed off the entry rather than imported: the config view has no door of its own. */
type McpServerConfigView = GrowthMcpInventoryEntry["config"];

function stdioConfigWithArguments(args: readonly string[]): McpServerConfigView {
  return { transport: "stdio", command: "./scripts/scratchpad-mcp", args };
}

function renderedArguments(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll(".meridian-mcp__argument-list li")].map(
    (item) => item.textContent ?? "",
  );
}

describe("ConfigReadBack — the served arguments", () => {
  it("renders each argument wire-verbatim rather than counting them", () => {
    const { container } = render(
      <ConfigReadBack config={stdioConfigWithArguments(["--read-only", "--root", "/srv/data"])} />,
    );
    expect(renderedArguments(container)).toEqual(["--read-only", "--root", "/srv/data"]);
  });

  it("tells two bindings apart that differ only in one argument", () => {
    const readOnly = render(<ConfigReadBack config={stdioConfigWithArguments(["--read-only"])} />);
    const allowWrite = render(
      <ConfigReadBack config={stdioConfigWithArguments(["--allow-write"])} />,
    );
    expect(readOnly.container.textContent).toContain("--read-only");
    expect(allowWrite.container.textContent).toContain("--allow-write");
    expect(readOnly.container.textContent).not.toBe(allowWrite.container.textContent);
  });

  // Order and repetition are both part of what argv means: `--root /a --root /b` is
  // two roots, and a list that folded the repeat would report one.
  it("keeps a repeated argument in the position the daemon served it", () => {
    const { container } = render(
      <ConfigReadBack config={stdioConfigWithArguments(["--root", "/a", "--root", "/b"])} />,
    );
    expect(renderedArguments(container)).toEqual(["--root", "/a", "--root", "/b"]);
  });

  // Absent and empty are the same fact here — this binding declares no arguments —
  // and both render as nothing rather than as an empty box.
  it("renders no argument list where the binding declares none", () => {
    const { container } = render(
      <ConfigReadBack config={{ transport: "stdio", command: "npx" }} />,
    );
    expect(container.querySelector(".meridian-mcp__argument-list")).toBeNull();
  });

  // The negative control on the reader above: an http binding has no `args` member at
  // all, so a selector that matched anything here would be matching the wrong thing.
  it("renders no argument list on the arm that carries no arguments", () => {
    const { container } = render(
      <ConfigReadBack
        config={{
          transport: "http",
          url: "https://issues.example.test/mcp",
          headerNames: ["X-Tenant"],
        }}
      />,
    );
    expect(container.querySelector(".meridian-mcp__argument-list")).toBeNull();
    expect(container.textContent).toContain("Headers sent");
  });
});
