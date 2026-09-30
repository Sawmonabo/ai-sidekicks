// The configuration read-back, driven against the arguments the daemon serves. The arguments
// decide what the command does: `--read-only` and `--allow-write` are opposite grants, so a
// count would call two different bindings identical. They are already in the redacted view the
// wire carries, so nothing withheld is disclosed.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ConfigReadBack } from "./ConfigReadBack.js";
import type { McpServerInventoryEntry } from "@ai-sidekicks/contracts";

/** Indexed off the entry rather than imported: the config view has no exported type of its own. */
type McpServerConfigView = McpServerInventoryEntry["config"];

afterEach(() => {
  cleanup();
});

function stdioConfigWithArguments(args: readonly string[]): McpServerConfigView {
  return { transport: "stdio", command: "./scripts/scratchpad-mcp", args: [...args] };
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

  // Order and repetition are part of argv: `--root /a --root /b` is two roots.
  it("keeps a repeated argument in the position the daemon served it", () => {
    const { container } = render(
      <ConfigReadBack config={stdioConfigWithArguments(["--root", "/a", "--root", "/b"])} />,
    );
    expect(renderedArguments(container)).toEqual(["--root", "/a", "--root", "/b"]);
  });

  // Absent and empty are the same fact (no arguments declared) and render as nothing.
  it("renders no argument list where the binding declares none", () => {
    const { container } = render(
      <ConfigReadBack config={{ transport: "stdio", command: "npx" }} />,
    );
    expect(container.querySelector(".meridian-mcp__argument-list")).toBeNull();
  });

  // Negative control on the reader: an http binding has no `args` member, so a selector that
  // matched here would be matching the wrong thing.
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
