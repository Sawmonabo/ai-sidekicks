// The speed chip reads the lead's model: `Fast` or `Standard` where the model has fast output, and
// `Standard` grayed with the model named in its reason where it has none, changing in place when
// the model changes.

import { describe, expect, it } from "vitest";

import type { ProviderModel } from "@ai-sidekicks/contracts/provider/driver/capabilities";

import { readSpeedChip } from "./speed.js";

const LEVELS = ["off", "on"];

function modelNamed(name: string, fast: boolean): ProviderModel {
  return {
    id: name.toLowerCase().replaceAll(" ", "-"),
    name,
    capabilities: [],
    outputSpeedLevels: LEVELS,
    fast,
    largerWindow: false,
  };
}

describe("the composer's speed chip", () => {
  it("follows the model: live on a fast model, grayed with the model's name on one without", () => {
    // Mutation: dropping the `fast` check leaves the chip live on a model with no fast output.
    const fastModel = modelNamed("Claude Sonnet 5", true);
    expect(readSpeedChip(fastModel, LEVELS, "on")).toStrictEqual({
      kind: "live",
      word: "Fast",
      standardLevel: "off",
      fastLevel: "on",
    });
    expect(readSpeedChip(fastModel, LEVELS, undefined)).toMatchObject({ word: "Standard" });

    expect(readSpeedChip(modelNamed("Claude Haiku 4.5", false), LEVELS, "on")).toStrictEqual({
      kind: "grayed",
      reason: "Claude Haiku 4.5 has no fast output.",
    });
  });

  it("grays with no reason while the lead's model is not read, and when one level is offered", () => {
    expect(readSpeedChip(undefined, LEVELS, undefined)).toStrictEqual({
      kind: "grayed",
      reason: undefined,
    });
    expect(readSpeedChip(modelNamed("GPT-5.6 Luna", true), ["standard"], undefined)).toStrictEqual({
      kind: "grayed",
      reason: "GPT-5.6 Luna has no fast output.",
    });
  });
});
