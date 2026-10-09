import { describe, expect, it } from "vitest";

import { answerClaudeOutputStyle, readClaudeCommandChoices } from "../answered-commands.js";

describe("readClaudeCommandChoices", () => {
  it("splits each style row on the style's own name, whatever colons it holds", () => {
    // A row is `- <name>[ (current)][: <description>]`; a name or a description may hold a colon.
    const choices = readClaudeCommandChoices({
      outputStyleNames: ["default", "Review: strict", "Concise"],
      outputStyle: {
        isListed: true,
        outcome: undefined,
        text: [
          "Output style: Concise",
          "",
          "Available styles:",
          "- default",
          "- Review: strict: Checks: every claim twice",
          "- Concise (current): Leads with results: skips preamble",
          "",
          "Usage: /output-style <style>",
        ].join("\n"),
      },
      advisor: {
        isListed: true,
        text: "Advisor: off\nUsage: /advisor <opus|off>",
        outcome: undefined,
      },
    });

    expect(choices.outputStyles).toStrictEqual({
      kind: "listed",
      descriptions: new Map([
        ["Review: strict", "Checks: every claim twice"],
        ["Concise", "Leads with results: skips preamble"],
      ]),
    });
    expect(
      answerClaudeOutputStyle(
        "",
        ["default", "Review: strict", "Concise"],
        "default",
        choices.outputStyles,
      ),
    ).toStrictEqual({
      kind: "listing",
      line: [
        "Output style: default",
        "",
        "Available styles:",
        "- default (current)",
        "- Review: strict: Checks: every claim twice",
        "- Concise: Leads with results: skips preamble",
        "",
        "Usage: /output-style <style>",
      ].join("\n"),
    });
  });

  it("tells an advisor Claude Code offers none of here from a build that stopped listing it", () => {
    // Shown as sent, the first says what the account has; the second is a version fault.
    const unavailableLine = "/advisor isn't available in this environment.";
    const read = (outcome: string): ReturnType<typeof readClaudeCommandChoices>["advisor"] =>
      readClaudeCommandChoices({
        outputStyleNames: [],
        outputStyle: { isListed: true, text: "Available styles:", outcome: undefined },
        advisor: { isListed: false, text: unavailableLine, outcome },
      }).advisor;

    expect(read("unavailable_headless")).toStrictEqual({
      kind: "unoffered",
      line: unavailableLine,
    });
    expect(read("unknown")).toStrictEqual({
      kind: "unlisted",
      line: "This Claude Code build does not list its advisors.",
    });
  });
});
