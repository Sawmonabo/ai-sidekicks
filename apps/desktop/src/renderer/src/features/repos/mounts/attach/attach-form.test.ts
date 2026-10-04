// What the attach form admits and what it does not decide: the two refusals the contract's
// parser would make, and no resolution, normalization, eligibility or trimming on the way out.

import { describe, expect, it } from "vitest";

import { FILE_PATH_MAX_LEN } from "@ai-sidekicks/contracts/session";

import { resolveAttachForm } from "./attach-form.js";

describe("resolveAttachForm — the path is checked and never rewritten", () => {
  it("refuses a path past the wire's own cap, and says by how much", () => {
    const tooLong = "/".repeat(FILE_PATH_MAX_LEN + 1);
    const verdict = resolveAttachForm({ localPath: tooLong });
    expect(verdict.status).toBe("incomplete");
    expect(verdict.status === "incomplete" && verdict.because).toContain(String(FILE_PATH_MAX_LEN));
  });

  it("sends a path exactly at the cap", () => {
    // The guard is `>` not `>=`: the contract's `max` admits the boundary, and refusing it
    // would refuse a path the daemon accepts.
    const atCap = "/".repeat(FILE_PATH_MAX_LEN);
    expect(resolveAttachForm({ localPath: atCap }).status).toBe("sendable");
  });

  it("sends what was typed, spaces and all", () => {
    // A leading or trailing space is a legal POSIX filename character: the emptiness guard
    // reads a trimmed copy, but the request carries the original.
    const verdict = resolveAttachForm({ localPath: " /Users/dev/code " });
    expect(verdict.status === "sendable" && verdict.localPath).toBe(" /Users/dev/code ");
  });

  it("refuses whitespace alone as a path", () => {
    expect(resolveAttachForm({ localPath: "   " }).status).toBe("incomplete");
  });
});
