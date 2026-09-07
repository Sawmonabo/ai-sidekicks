// Reconciling a pick against a served answer, in the four states the two dialogs reach.
//
// EVERY CASE HERE IS A DISAGREEMENT THAT SHIPPED. The picker read the served answer and
// the verdict read the form, so each arm below names a state where the two said
// different things: a default the picker drew and the form never held, a pick the served
// answer had withdrawn, and a pick nothing was answering about at all.
//
// THE TWO ABSENCES ARE THE HARDEST PART, and each has its own negative control: an
// answer naming NO choices withdraws a pick, and NO answer at all cannot confirm one.
// Folding them together would either send an id the session has dropped or refuse one
// it still holds.

import { describe, expect, it } from "vitest";

import { resolveServedSelection, selectedChoiceOf } from "./served-selection.js";

/** Two nodes, which is a real decision. */
const TWO_CHOICES: readonly string[] = ["node-a", "node-b"];

describe("resolveServedSelection — a pick the served answer still offers", () => {
  it("resolves the participant's own pick", () => {
    const selection = resolveServedSelection({
      chosen: "node-b",
      servedChoices: TWO_CHOICES,
      defaultChoice: undefined,
    });
    expect(selection).toStrictEqual({ status: "resolved", choice: "node-b" });
  });

  it("prefers the pick over the default, which is what makes it a pick", () => {
    const selection = resolveServedSelection({
      chosen: "node-b",
      servedChoices: TWO_CHOICES,
      defaultChoice: "node-a",
    });
    expect(selectedChoiceOf(selection)).toBe("node-b");
  });
});

describe("resolveServedSelection — no pick, and a default to stand in", () => {
  it("resolves the default the served answer names", () => {
    const selection = resolveServedSelection({
      chosen: undefined,
      servedChoices: ["node-only"],
      defaultChoice: "node-only",
    });
    expect(selection).toStrictEqual({ status: "resolved", choice: "node-only" });
  });

  it("negative control: a default outside the served set resolves nothing", () => {
    // A reply that disagrees with itself must not have one half of it believed here: a
    // default the picker would draw as unavailable is not a choice this form may send.
    const selection = resolveServedSelection({
      chosen: undefined,
      servedChoices: ["read-only"],
      defaultChoice: "worktree",
    });
    expect(selection).toStrictEqual({ status: "unresolved" });
    expect(selectedChoiceOf(selection)).toBeUndefined();
  });

  it("negative control: no pick and no default is unresolved", () => {
    const selection = resolveServedSelection({
      chosen: undefined,
      servedChoices: TWO_CHOICES,
      defaultChoice: undefined,
    });
    expect(selection).toStrictEqual({ status: "unresolved" });
  });
});

describe("resolveServedSelection — a pick the served answer has withdrawn", () => {
  it("withdraws it and carries what was picked, so a sentence can name it", () => {
    const selection = resolveServedSelection({
      chosen: "node-b",
      servedChoices: ["node-a"],
      defaultChoice: "node-a",
    });
    expect(selection).toStrictEqual({ status: "withdrawn", choice: "node-b" });
  });

  it("does not quietly fall back to the default, which would send a different choice", () => {
    // The failure this exists to refuse: a refresh that removed the picked node would
    // otherwise hand the act whichever node happened to be default now.
    const selection = resolveServedSelection({
      chosen: "node-b",
      servedChoices: ["node-a"],
      defaultChoice: "node-a",
    });
    expect(selectedChoiceOf(selection)).toBeUndefined();
  });

  it("an answer naming no choices at all withdraws the pick", () => {
    // A read that answered with an empty set HAS answered — a session with no nodes, a
    // mount that admits no mode — so a pick made against the previous answer is gone.
    const selection = resolveServedSelection({
      chosen: "node-a",
      servedChoices: [],
      defaultChoice: undefined,
    });
    expect(selection).toStrictEqual({ status: "withdrawn", choice: "node-a" });
  });
});

describe("resolveServedSelection — nothing being served to check against", () => {
  it("holds the pick unconfirmed rather than calling it withdrawn", () => {
    // Different fact, different sentence: a read that has not answered cannot say the
    // choice is gone, and a control shut with that reason under it would be lying.
    const selection = resolveServedSelection({
      chosen: "node-a",
      servedChoices: undefined,
      defaultChoice: undefined,
    });
    expect(selection).toStrictEqual({ status: "unserved", choice: "node-a" });
    expect(selectedChoiceOf(selection)).toBeUndefined();
  });

  it("negative control: with no pick either, it is simply unresolved", () => {
    const selection = resolveServedSelection({
      chosen: undefined,
      servedChoices: undefined,
      defaultChoice: "node-a",
    });
    expect(selection).toStrictEqual({ status: "unresolved" });
  });
});
