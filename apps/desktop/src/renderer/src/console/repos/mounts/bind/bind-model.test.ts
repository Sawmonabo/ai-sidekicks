// What a bind form sends, and what it refuses to send.
//
// THE CASES THAT MATTER HERE ARE THE ONES WHERE A CONVENIENCE WOULD BE A LIE: a mode
// defaulted for the caller, a directory trimmed on the way out, and an empty field sent
// as an empty string rather than omitted. Each has a negative control beside it.

import { REPO_PATH_MAX_LEN } from "@ai-sidekicks/contracts";
import type { WorkspaceExecutionModeCapabilitiesReadResponse } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import {
  defaultBindMode,
  EMPTY_BIND_FORM,
  resolveBindForm,
  type BindFormState,
  type BindFormVerdict,
} from "./bind-model.js";

/** A git mount's answer: every mode, nothing restricted. */
const GIT_CAPABILITIES: WorkspaceExecutionModeCapabilitiesReadResponse = {
  availableModes: ["read-only", "branch", "worktree", "ephemeral clone"],
  defaultMode: "worktree",
};

/**
 * A reply that disagrees with itself, which is the one way a mount serves no default.
 *
 * `defaultMode` is required on the wire, so "no default" is never an absent member —
 * it is a default the same reply does not offer, and `defaultBindMode` refuses to
 * believe half of such a reply.
 */
const NO_DEFAULT_CAPABILITIES: WorkspaceExecutionModeCapabilitiesReadResponse = {
  availableModes: ["read-only", "branch", "worktree", "ephemeral clone"],
  defaultMode: "unavailable-here" as WorkspaceExecutionModeCapabilitiesReadResponse["defaultMode"],
};

/** The verdict for one form read against what a mount admits. */
function verdictFor(
  form: BindFormState,
  capabilities: WorkspaceExecutionModeCapabilitiesReadResponse = GIT_CAPABILITIES,
): BindFormVerdict {
  return resolveBindForm(form, capabilities).verdict;
}

describe("resolveBindForm", () => {
  it("refuses a form with no mode chosen and no default served, and says which is missing", () => {
    const verdict = verdictFor(EMPTY_BIND_FORM, NO_DEFAULT_CAPABILITIES);
    expect(verdict.status).toBe("incomplete");
    expect(verdict.status === "incomplete" && verdict.because).toContain("execution mode");
  });

  it("never invents a mode of the console's own", () => {
    // `repo.workspaceBind` refuses to make "omitted a mode" and "chose read-only" the
    // same request. What stands in for a pick is the mount's OWN `defaultMode` and
    // nothing else, so a reply naming none leaves the form incomplete.
    const verdict = verdictFor(
      { directory: "", executionMode: undefined },
      NO_DEFAULT_CAPABILITIES,
    );
    expect(verdict.status).not.toBe("sendable");
  });

  it("stands the mount's own default in for a pick nobody has made", () => {
    // Derived per read rather than written into the form, which is what makes it
    // survive a close: the pre-fill it replaces ran once per mount and a reopened
    // dialog met a picker with nothing chosen.
    const resolution = resolveBindForm(EMPTY_BIND_FORM, GIT_CAPABILITIES);
    expect(resolution.selectedMode).toBe("worktree");
    expect(resolution.verdict.status).toBe("sendable");
  });

  it("clears a picked mode the mount no longer admits, and says why", () => {
    // The state this fix was written for: the picker drew the row excluded while the
    // verdict read the form alone, so Bind stayed open over a mode the reply excludes.
    const resolution = resolveBindForm(
      { directory: "", executionMode: "worktree" },
      { availableModes: ["read-only"], defaultMode: "read-only" },
    );
    expect(resolution.selectedMode).toBeUndefined();
    expect(resolution.verdict.status).toBe("incomplete");
    expect(resolution.verdict.status === "incomplete" && resolution.verdict.because).toContain(
      "no longer one this mount admits",
    );
  });

  it("does not substitute the new default for a mode that was picked", () => {
    // Binding in whichever mode is default now is not the act the user asked for.
    const { verdict } = resolveBindForm(
      { directory: "", executionMode: "worktree" },
      { availableModes: ["read-only"], defaultMode: "read-only" },
    );
    expect(verdict.status).not.toBe("sendable");
  });

  it("holds a picked mode unconfirmed while the read has not answered", () => {
    const { verdict } = resolveBindForm({ directory: "", executionMode: "worktree" }, undefined);
    expect(verdict.status).toBe("incomplete");
    expect(verdict.status === "incomplete" && verdict.because).toContain("has not answered");
  });

  it("omits an empty directory rather than sending an empty path", () => {
    const verdict = verdictFor({ directory: "", executionMode: "worktree" });
    expect(verdict.status).toBe("sendable");
    expect(verdict.status === "sendable" && verdict.directory).toBeUndefined();
  });

  it("omits a whitespace-only directory too", () => {
    const verdict = verdictFor({ directory: "   ", executionMode: "worktree" });
    expect(verdict.status === "sendable" && verdict.directory).toBeUndefined();
  });

  it("sends a padded directory byte for byte", () => {
    // A leading or trailing space is a legal POSIX filename character. Trimming on the
    // way out would bind a different directory from the one that was named — silently,
    // and only for the paths where it matters.
    const verdict = verdictFor({ directory: " packages/api ", executionMode: "branch" });
    expect(verdict.status === "sendable" && verdict.directory).toBe(" packages/api ");
  });

  it("refuses a directory past the wire's cap, naming both lengths", () => {
    const overCap = "a".repeat(REPO_PATH_MAX_LEN + 1);
    const verdict = verdictFor({ directory: overCap, executionMode: "worktree" });
    expect(verdict.status).toBe("incomplete");
    expect(verdict.status === "incomplete" && verdict.because).toContain(
      String(REPO_PATH_MAX_LEN + 1),
    );
  });

  it("negative control: a directory exactly at the cap is sendable", () => {
    const atCap = "a".repeat(REPO_PATH_MAX_LEN);
    const verdict = verdictFor({ directory: atCap, executionMode: "worktree" });
    expect(verdict.status).toBe("sendable");
  });

  it("checks the length before the mode, which is the order a person meets them", () => {
    const overCap = "a".repeat(REPO_PATH_MAX_LEN + 1);
    const verdict = verdictFor({ directory: overCap, executionMode: undefined });
    expect(verdict.status === "incomplete" && verdict.because).toContain("characters");
  });
});

describe("defaultBindMode", () => {
  it("pre-fills the daemon's own default", () => {
    expect(defaultBindMode(GIT_CAPABILITIES)).toBe("worktree");
  });

  it("negative control: a default the reply does not offer pre-fills nothing", () => {
    // Never a guess of the console's. A reply that disagrees with itself leaves the
    // user to choose rather than having a mode chosen for them.
    expect(
      defaultBindMode({ availableModes: ["read-only"], defaultMode: "worktree" }),
    ).toBeUndefined();
  });
});
