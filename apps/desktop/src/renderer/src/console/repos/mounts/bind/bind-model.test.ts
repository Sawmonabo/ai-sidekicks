// What a bind form sends, and what it refuses to send.
//
// THE CASES THAT MATTER HERE ARE THE ONES WHERE A CONVENIENCE WOULD BE A LIE: a mode
// defaulted for the caller, a directory trimmed on the way out, and an empty field sent
// as an empty string rather than omitted. Each has a negative control beside it.

import { REPO_PATH_MAX_LEN } from "@ai-sidekicks/contracts";
import type { WorkspaceExecutionModeCapabilitiesReadResponse } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import {
  bindFormVerdict,
  bindModeOptions,
  defaultBindMode,
  EMPTY_BIND_FORM,
} from "./bind-model.js";

/** A git mount's answer: every mode, nothing restricted. */
const GIT_CAPABILITIES: WorkspaceExecutionModeCapabilitiesReadResponse = {
  availableModes: ["read-only", "branch", "worktree", "ephemeral clone"],
  defaultMode: "worktree",
};

/** A plain directory's answer: one mode, three excluded with reasons. */
const PLAIN_CAPABILITIES: WorkspaceExecutionModeCapabilitiesReadResponse = {
  availableModes: ["read-only"],
  defaultMode: "read-only",
  restrictions: {
    branch: "This mount is not a git repository, so there is no branch to create.",
    worktree: "This mount is not a git repository, so no worktree can be added.",
    "ephemeral clone": "This mount is not a git repository, so there is nothing to clone.",
  },
};

describe("bindFormVerdict", () => {
  it("refuses a form with no mode chosen, and says which choice is missing", () => {
    const verdict = bindFormVerdict(EMPTY_BIND_FORM);
    expect(verdict.status).toBe("incomplete");
    expect(verdict.status === "incomplete" && verdict.because).toContain("execution mode");
  });

  it("never defaults the mode, which is the wire's own distinction", () => {
    // `repo.workspaceBind` refuses to make "omitted a mode" and "chose read-only" the
    // same request. A default written into this form would put that back where nobody
    // could see it, so an empty form is INCOMPLETE rather than a read-only bind.
    const verdict = bindFormVerdict({ directory: "", executionMode: undefined });
    expect(verdict.status).not.toBe("sendable");
  });

  it("omits an empty directory rather than sending an empty path", () => {
    const verdict = bindFormVerdict({ directory: "", executionMode: "worktree" });
    expect(verdict.status).toBe("sendable");
    expect(verdict.status === "sendable" && verdict.directory).toBeUndefined();
  });

  it("omits a whitespace-only directory too", () => {
    const verdict = bindFormVerdict({ directory: "   ", executionMode: "worktree" });
    expect(verdict.status === "sendable" && verdict.directory).toBeUndefined();
  });

  it("sends a padded directory byte for byte", () => {
    // A leading or trailing space is a legal POSIX filename character. Trimming on the
    // way out would bind a different directory from the one that was named — silently,
    // and only for the paths where it matters.
    const verdict = bindFormVerdict({ directory: " packages/api ", executionMode: "branch" });
    expect(verdict.status === "sendable" && verdict.directory).toBe(" packages/api ");
  });

  it("refuses a directory past the wire's cap, naming both lengths", () => {
    const overCap = "a".repeat(REPO_PATH_MAX_LEN + 1);
    const verdict = bindFormVerdict({ directory: overCap, executionMode: "worktree" });
    expect(verdict.status).toBe("incomplete");
    expect(verdict.status === "incomplete" && verdict.because).toContain(
      String(REPO_PATH_MAX_LEN + 1),
    );
  });

  it("negative control: a directory exactly at the cap is sendable", () => {
    const atCap = "a".repeat(REPO_PATH_MAX_LEN);
    const verdict = bindFormVerdict({ directory: atCap, executionMode: "worktree" });
    expect(verdict.status).toBe("sendable");
  });

  it("checks the length before the mode, which is the order a person meets them", () => {
    const overCap = "a".repeat(REPO_PATH_MAX_LEN + 1);
    const verdict = bindFormVerdict({ directory: overCap, executionMode: undefined });
    expect(verdict.status === "incomplete" && verdict.because).toContain("characters");
  });
});

describe("bindModeOptions", () => {
  it("offers every available mode in the reply's own order", () => {
    const options = bindModeOptions(GIT_CAPABILITIES);
    expect(options.map((option) => option.mode)).toStrictEqual([
      "read-only",
      "branch",
      "worktree",
      "ephemeral clone",
    ]);
    expect(options.every((option) => option.available)).toBe(true);
  });

  it("renders an excluded mode with the mount's own reason rather than dropping it", () => {
    const options = bindModeOptions(PLAIN_CAPABILITIES);
    const excluded = options.filter((option) => !option.available);
    expect(excluded.map((option) => option.mode)).toStrictEqual([
      "branch",
      "worktree",
      "ephemeral clone",
    ]);
    expect(excluded[0]?.restrictionReason).toContain("not a git repository");
  });

  it("negative control: a restriction naming an AVAILABLE mode adds no row", () => {
    // The reply is the authority on what is admitted; a stale restriction entry must
    // not turn an offered mode into a disabled one.
    const options = bindModeOptions({
      availableModes: ["read-only", "branch"],
      defaultMode: "branch",
      restrictions: { branch: "stale" },
    });
    expect(options).toHaveLength(2);
    expect(options.every((option) => option.available)).toBe(true);
  });

  it("negative control: no restrictions map at all yields only the available rows", () => {
    expect(bindModeOptions(GIT_CAPABILITIES).filter((option) => !option.available)).toStrictEqual(
      [],
    );
  });
});

describe("defaultBindMode", () => {
  it("pre-fills the daemon's own default", () => {
    expect(defaultBindMode(GIT_CAPABILITIES)).toBe("worktree");
  });

  it("negative control: a default the reply does not offer pre-fills nothing", () => {
    // Never a guess of the console's. A reply that disagrees with itself leaves the
    // participant to choose rather than having a mode chosen for them.
    expect(
      defaultBindMode({ availableModes: ["read-only"], defaultMode: "worktree" }),
    ).toBeUndefined();
  });
});
