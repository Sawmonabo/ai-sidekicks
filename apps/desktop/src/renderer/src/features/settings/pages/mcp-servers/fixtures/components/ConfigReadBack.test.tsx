// The configuration read-back, driven against the arguments the daemon serves. The arguments
// decide what the command does: `--read-only` and `--allow-write` are opposite grants, so a
// count would call two different bindings identical. They are already in the redacted view the
// wire carries, so nothing withheld is disclosed.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ConfigReadBack } from "./ConfigReadBack.js";

afterEach(() => {
  cleanup();
});

describe("ConfigReadBack — the served arguments", () => {
  it("renders each argument wire-verbatim rather than counting them", () => {
    const { container } = render(
      <ConfigReadBack
        config={{
          transport: "stdio",
          command: "./scripts/scratchpad-mcp",
          args: ["--read-only", "--root", "/srv/data"],
        }}
      />,
    );
    const renderedArguments = [
      ...container.querySelectorAll(".meridian-mcp__argument-list li"),
    ].map((item) => item.textContent ?? "");
    expect(renderedArguments).toEqual(["--read-only", "--root", "/srv/data"]);
  });
});
