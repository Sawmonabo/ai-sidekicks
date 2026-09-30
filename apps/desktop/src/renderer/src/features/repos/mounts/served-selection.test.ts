// Reconciling a pick against a served answer, in the four states a dialog reaches. Each arm is
// a disagreement a split reading would produce; the two absences (an answer naming no choices
// withdraws a pick, no answer cannot confirm one) each have a negative control.

import { describe, expect, it } from "vitest";

import { resolveServedSelection, selectedChoiceOf } from "./served-selection.js";

/** Two served choices, which is a real decision. */
const TWO_CHOICES: readonly string[] = ["choice-a", "choice-b"];

describe("resolveServedSelection — a pick the served answer still offers", () => {
  it("resolves the user's own pick", () => {
    const selection = resolveServedSelection({
      chosen: "choice-b",
      servedChoices: TWO_CHOICES,
      defaultChoice: undefined,
    });
    expect(selection).toStrictEqual({ status: "resolved", choice: "choice-b" });
  });

  it("prefers the pick over the default, which is what makes it a pick", () => {
    const selection = resolveServedSelection({
      chosen: "choice-b",
      servedChoices: TWO_CHOICES,
      defaultChoice: "choice-a",
    });
    expect(selectedChoiceOf(selection)).toBe("choice-b");
  });
});

describe("resolveServedSelection — no pick, and a default to stand in", () => {
  it("resolves the default the served answer names", () => {
    const selection = resolveServedSelection({
      chosen: undefined,
      servedChoices: ["choice-only"],
      defaultChoice: "choice-only",
    });
    expect(selection).toStrictEqual({ status: "resolved", choice: "choice-only" });
  });

  it("negative control: a default outside the served set resolves nothing", () => {
    // A default the picker would draw as unavailable is not a choice this form may send.
    const selection = resolveServedSelection({
      chosen: undefined,
      servedChoices: ["choice-only"],
      defaultChoice: "choice-b",
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
      chosen: "choice-b",
      servedChoices: ["choice-a"],
      defaultChoice: "choice-a",
    });
    expect(selection).toStrictEqual({ status: "withdrawn", choice: "choice-b" });
  });

  it("does not quietly fall back to the default, which would send a different choice", () => {
    // A refresh that removed the picked choice must not hand the act the default instead.
    const selection = resolveServedSelection({
      chosen: "choice-b",
      servedChoices: ["choice-a"],
      defaultChoice: "choice-a",
    });
    expect(selectedChoiceOf(selection)).toBeUndefined();
  });

  it("an answer naming no choices at all withdraws the pick", () => {
    // An empty set is an answer (a mount that admits no mode), so the earlier pick is gone.
    const selection = resolveServedSelection({
      chosen: "choice-a",
      servedChoices: [],
      defaultChoice: undefined,
    });
    expect(selection).toStrictEqual({ status: "withdrawn", choice: "choice-a" });
  });
});

describe("resolveServedSelection — nothing being served to check against", () => {
  it("holds the pick unconfirmed rather than calling it withdrawn", () => {
    // A read that has not answered cannot say the choice is gone.
    const selection = resolveServedSelection({
      chosen: "choice-a",
      servedChoices: undefined,
      defaultChoice: undefined,
    });
    expect(selection).toStrictEqual({ status: "unserved", choice: "choice-a" });
    expect(selectedChoiceOf(selection)).toBeUndefined();
  });

  it("negative control: with no pick either, it is simply unresolved", () => {
    const selection = resolveServedSelection({
      chosen: undefined,
      servedChoices: undefined,
      defaultChoice: "choice-a",
    });
    expect(selection).toStrictEqual({ status: "unresolved" });
  });
});
