// What a bind form sends, and what it refuses to send.

import { FILE_PATH_MAX_LEN } from "@ai-sidekicks/contracts";
import type { WorkspaceExecutionModeCapabilitiesReadResponse } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import {
  defaultBindMode,
  EMPTY_BIND_FORM,
  resolveBindForm,
  type BindFormState,
  type BindFormVerdict,
} from "./bind-form.js";

const GIT_CAPABILITIES: WorkspaceExecutionModeCapabilitiesReadResponse = {
  availableModes: ["bound-root", "provisioned-worktree"],
  defaultMode: "provisioned-worktree",
};

/** A reply that disagrees with itself: its `defaultMode` is one it does not offer. */
const NO_DEFAULT_CAPABILITIES: WorkspaceExecutionModeCapabilitiesReadResponse = {
  availableModes: ["bound-root", "provisioned-worktree"],
  defaultMode: "unavailable-here" as WorkspaceExecutionModeCapabilitiesReadResponse["defaultMode"],
};

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
    // The mount's own `defaultMode` is the only thing that stands in for a pick, so a reply
    // naming none leaves the form incomplete.
    const verdict = verdictFor(
      { directory: "", executionMode: undefined },
      NO_DEFAULT_CAPABILITIES,
    );
    expect(verdict.status).not.toBe("sendable");
  });

  it("stands the mount's own default in for a pick nobody has made", () => {
    // Derived per read, not written into the form, so a reopened dialog gets it again.
    const resolution = resolveBindForm(EMPTY_BIND_FORM, GIT_CAPABILITIES);
    expect(resolution.selectedMode).toBe("provisioned-worktree");
    expect(resolution.verdict.status).toBe("sendable");
  });

  it("clears a picked mode the mount no longer admits, and says why", () => {
    // The picker draws the row excluded, so the verdict must too.
    const resolution = resolveBindForm(
      { directory: "", executionMode: "provisioned-worktree" },
      { availableModes: ["bound-root"], defaultMode: "bound-root" },
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
      { directory: "", executionMode: "provisioned-worktree" },
      { availableModes: ["bound-root"], defaultMode: "bound-root" },
    );
    expect(verdict.status).not.toBe("sendable");
  });

  it("holds a picked mode unconfirmed while the read has not answered", () => {
    const { verdict } = resolveBindForm(
      { directory: "", executionMode: "provisioned-worktree" },
      undefined,
    );
    expect(verdict.status).toBe("incomplete");
    expect(verdict.status === "incomplete" && verdict.because).toContain("has not answered");
  });

  it("omits an empty directory rather than sending an empty path", () => {
    const verdict = verdictFor({ directory: "", executionMode: "provisioned-worktree" });
    expect(verdict.status).toBe("sendable");
    expect(verdict.status === "sendable" && verdict.directory).toBeUndefined();
  });

  it("omits a whitespace-only directory too", () => {
    const verdict = verdictFor({ directory: "   ", executionMode: "provisioned-worktree" });
    expect(verdict.status === "sendable" && verdict.directory).toBeUndefined();
  });

  it("sends a padded directory byte for byte", () => {
    // Edge spaces are legal POSIX filename characters; trimming would bind another directory.
    const verdict = verdictFor({ directory: " packages/api ", executionMode: "bound-root" });
    expect(verdict.status === "sendable" && verdict.directory).toBe(" packages/api ");
  });

  it("refuses a directory past the wire's cap, naming both lengths", () => {
    const overCap = "a".repeat(FILE_PATH_MAX_LEN + 1);
    const verdict = verdictFor({ directory: overCap, executionMode: "provisioned-worktree" });
    expect(verdict.status).toBe("incomplete");
    expect(verdict.status === "incomplete" && verdict.because).toContain(
      String(FILE_PATH_MAX_LEN + 1),
    );
  });

  it("negative control: a directory exactly at the cap is sendable", () => {
    const atCap = "a".repeat(FILE_PATH_MAX_LEN);
    const verdict = verdictFor({ directory: atCap, executionMode: "provisioned-worktree" });
    expect(verdict.status).toBe("sendable");
  });

  it("checks the length before the mode, which is the order a person meets them", () => {
    const overCap = "a".repeat(FILE_PATH_MAX_LEN + 1);
    const verdict = verdictFor({ directory: overCap, executionMode: undefined });
    expect(verdict.status === "incomplete" && verdict.because).toContain("characters");
  });
});

describe("defaultBindMode", () => {
  it("pre-fills the daemon's own default", () => {
    expect(defaultBindMode(GIT_CAPABILITIES)).toBe("provisioned-worktree");
  });

  it("negative control: a default the reply does not offer pre-fills nothing", () => {
    // A reply that disagrees with itself leaves the user to choose.
    expect(
      defaultBindMode({ availableModes: ["bound-root"], defaultMode: "provisioned-worktree" }),
    ).toBeUndefined();
  });
});
