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

describe("ConfigReadBack — how the server runs", () => {
  it("says a command or an address in the add form's words, never the transport", () => {
    const drawn = [
      { config: { transport: "stdio", command: "npx" }, words: "A command" },
      { config: { transport: "http", url: "https://mcp.example.test/" }, words: "An address" },
      { config: { transport: "sse", url: "https://mcp.example.test/sse" }, words: "An address" },
    ] as const;
    for (const { config, words } of drawn) {
      const { container, unmount } = render(<ConfigReadBack config={config} />);
      expect(container.querySelector(".meridian-chip__label")?.textContent).toBe(words);
      unmount();
    }
  });
});
