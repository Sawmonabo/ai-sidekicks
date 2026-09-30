// What the attach form admits, and what it does not decide.
//
// THE TWO REFUSALS THIS MODULE MAKES ARE THE TWO THE CONTRACT'S PARSER WOULD MAKE, and
// every case below is about not making a third: no resolution, no normalization, no
// eligibility, and no trimming on the way out.

import { describe, expect, it } from "vitest";

import { FILE_PATH_MAX_LEN } from "@ai-sidekicks/contracts";

import { EMPTY_ATTACH_FORM, resolveAttachForm } from "./attach-form.js";

describe("resolveAttachForm — the path is checked and never rewritten", () => {
  it("asks for the path over an empty form", () => {
    const verdict = resolveAttachForm(EMPTY_ATTACH_FORM).verdict;
    expect(verdict.status).toBe("incomplete");
    expect(verdict.status === "incomplete" && verdict.because).toContain("path");
  });

  it("refuses a path past the wire's own cap, and says by how much", () => {
    const tooLong = "/".repeat(FILE_PATH_MAX_LEN + 1);
    const verdict = resolveAttachForm({ localPath: tooLong }).verdict;
    expect(verdict.status).toBe("incomplete");
    expect(verdict.status === "incomplete" && verdict.because).toContain(String(FILE_PATH_MAX_LEN));
  });

  it("negative control: a path exactly at the cap is sendable", () => {
    // The guard is `>` and not `>=`, because the contract's own `max` admits the
    // boundary — a console refusing it would refuse a path the daemon accepts.
    const atCap = "/".repeat(FILE_PATH_MAX_LEN);
    expect(resolveAttachForm({ localPath: atCap }).verdict.status).toBe("sendable");
  });

  it("sends what was typed, spaces and all", () => {
    // A leading or trailing space is a legal POSIX filename character. The emptiness
    // guard reads a trimmed COPY; the request carries the original.
    const verdict = resolveAttachForm({ localPath: " /Users/dev/code " }).verdict;
    expect(verdict.status === "sendable" && verdict.localPath).toBe(" /Users/dev/code ");
  });

  it("negative control: whitespace alone is not a path", () => {
    expect(resolveAttachForm({ localPath: "   " }).verdict.status).toBe("incomplete");
  });
});
