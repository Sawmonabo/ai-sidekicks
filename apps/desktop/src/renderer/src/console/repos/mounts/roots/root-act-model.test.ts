// What a reuse reply means, what a prepare form admits, and what a disposal states.
//
// THE ORDERING CLAIM IS THE ONE THAT MATTERS. A candidate that is both dirty and
// incompatible must read as incompatible, because the dirty arm carries a consent
// control and consenting to a candidate that cannot be bound is a press already decided.

import { describe, expect, it } from "vitest";

import type { WorktreeReuseCheckResponse } from "@ai-sidekicks/contracts";

import {
  DISPOSAL_CONSEQUENCE,
  EMPTY_PREPARE_FORM,
  REUSE_VERDICT_COPY,
  disposalSubjectFor,
  prepareFormVerdict,
  reuseConsentRequired,
  reusePreparable,
  reuseVerdictFor,
} from "./root-act-model.js";

const WORKTREE_ID = "9f2c4a10-0000-4000-8000-000000000020";

function reply(overrides: Partial<WorktreeReuseCheckResponse> = {}): WorktreeReuseCheckResponse {
  return { available: true, worktreeId: WORKTREE_ID, ...overrides } as WorktreeReuseCheckResponse;
}

describe("reuseVerdictFor", () => {
  it("reads no candidate as none", () => {
    expect(reuseVerdictFor({ available: false } as WorktreeReuseCheckResponse).kind).toBe("none");
  });

  it("reads a clean, compatible candidate as reusable", () => {
    expect(reuseVerdictFor(reply({ compatible: true, isClean: true })).kind).toBe("reusable");
  });

  it("reads a dirty, compatible candidate as dirty and carries its reason", () => {
    const verdict = reuseVerdictFor(reply({ compatible: true, isClean: false, reason: "3 files" }));
    expect(verdict.kind).toBe("dirty");
    expect(verdict.kind === "dirty" && verdict.reason).toBe("3 files");
  });

  it("reads a candidate that is both dirty and incompatible as incompatible", () => {
    // The precedence is the claim: the reverse order would put a consent control in
    // front of a candidate no consent can make bindable.
    expect(reuseVerdictFor(reply({ compatible: false, isClean: false })).kind).toBe("incompatible");
  });

  it("negative control: an absent `compatible` is not read as permission", () => {
    // The three verdict members are optional on the wire because they are meaningless
    // when nothing is available. Reading absence as yes consents for the daemon.
    expect(reuseVerdictFor(reply({ isClean: true })).kind).toBe("incompatible");
  });

  it("negative control: an available reply with no id is no candidate", () => {
    expect(
      reuseVerdictFor({
        available: true,
        compatible: true,
        isClean: true,
      } as WorktreeReuseCheckResponse).kind,
    ).toBe("none");
  });
});

describe("reuseConsentRequired / reusePreparable", () => {
  it("asks for consent on the dirty arm alone", () => {
    expect(
      reuseConsentRequired({ kind: "dirty", worktreeId: WORKTREE_ID, reason: undefined }),
    ).toBe(true);
    expect(reuseConsentRequired({ kind: "reusable", worktreeId: WORKTREE_ID })).toBe(false);
    expect(reuseConsentRequired({ kind: "none" })).toBe(false);
  });

  it("refuses to prepare against an incompatible candidate and nothing else", () => {
    expect(
      reusePreparable({ kind: "incompatible", worktreeId: WORKTREE_ID, reason: undefined }),
    ).toBe(false);
    expect(reusePreparable({ kind: "none" })).toBe(true);
  });
});

describe("prepareFormVerdict", () => {
  it("asks for a branch first", () => {
    const verdict = prepareFormVerdict(EMPTY_PREPARE_FORM, { kind: "none" });
    expect(verdict.status === "incomplete" && verdict.because).toContain("branch");
  });

  it("sends an ordinary prepare with a branch and no candidate", () => {
    expect(
      prepareFormVerdict(
        { branchName: "feat/x", acknowledgeDirtyCandidate: false },
        { kind: "none" },
      ).status,
    ).toBe("sendable");
  });

  it("holds a dirty candidate until the consent is given", () => {
    const dirty = { kind: "dirty", worktreeId: WORKTREE_ID, reason: undefined } as const;
    expect(
      prepareFormVerdict({ branchName: "feat/x", acknowledgeDirtyCandidate: false }, dirty).status,
    ).toBe("incomplete");
    expect(
      prepareFormVerdict({ branchName: "feat/x", acknowledgeDirtyCandidate: true }, dirty).status,
    ).toBe("sendable");
  });

  it("negative control: consent does not make an incompatible candidate sendable", () => {
    const verdict = prepareFormVerdict(
      { branchName: "feat/x", acknowledgeDirtyCandidate: true },
      { kind: "incompatible", worktreeId: WORKTREE_ID, reason: undefined },
    );
    expect(verdict.status).toBe("incomplete");
    expect(verdict.status === "incomplete" && verdict.because).toBe(
      REUSE_VERDICT_COPY.incompatible,
    );
  });
});

describe("disposalSubjectFor", () => {
  it("keeps the two consequences apart", () => {
    // Retiring RECORDS a transition and the sweep removes the files afterwards;
    // disposing a clone brings forward a terminal it would have reached anyway. A
    // shared sentence would be wrong for one of them — and the wrong half is what a
    // person is consenting to.
    expect(DISPOSAL_CONSEQUENCE.worktree).not.toBe(DISPOSAL_CONSEQUENCE["ephemeral-clone"]);
    expect(DISPOSAL_CONSEQUENCE.worktree.trim().length).toBeGreaterThan(0);
    expect(DISPOSAL_CONSEQUENCE["ephemeral-clone"].trim().length).toBeGreaterThan(0);
  });

  it("carries the kind and the id the act will send", () => {
    const subject = disposalSubjectFor("worktree", WORKTREE_ID);
    expect(subject.kind).toBe("worktree");
    expect(subject.rootId).toBe(WORKTREE_ID);
  });
});
