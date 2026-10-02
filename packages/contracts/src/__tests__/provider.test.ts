// The provider-settings rules the settings page relies on: a compaction bound between the
// provider's own stops, an output style the installed build lists, and an update that changes
// exactly one setting, one its provider has.
import { describe, expect, it } from "vitest";

import { ProviderListResponseSchema, ProviderUpdateRequestSchema } from "../provider.js";

function claudeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: "claude",
    installation: { state: "installed", version: "2.1.271" },
    commandPath: null,
    availableForNewSessions: true,
    helpersAtOnce: null,
    autoCompactPercent: { value: 80, lowest: 50, highest: 95 },
    outputStyle: {
      current: "Explanatory",
      styles: [
        { name: "default" },
        { name: "Explanatory", description: "Answers that explain the reasoning as they go." },
      ],
    },
    terminalPluginEnabled: false,
    ...overrides,
  };
}

function codexRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: "codex",
    installation: { state: "tooOld", version: "0.140.0", neededVersion: "0.156.0" },
    commandPath: "/Users/person/.local/bin/codex",
    availableForNewSessions: false,
    helpersAtOnce: 4,
    autoCompactPercent: null,
    terminalSessionsReachable: true,
    ...overrides,
  };
}

function listReply(...providers: Record<string, unknown>[]): boolean {
  return ProviderListResponseSchema.safeParse({ providers }).success;
}

describe("provider.list", () => {
  it("reads each provider's section with only its own knobs", () => {
    expect(listReply(claudeRow(), codexRow())).toBe(true);
    expect(
      listReply(
        claudeRow({ installation: { state: "notInstalled" }, outputStyle: null }),
        codexRow({ installation: { state: "indeterminate" } }),
      ),
    ).toBe(true);
    // The output style and the terminal plugin are Claude Code's alone, the
    // shared terminal service Codex's alone.
    expect(listReply(codexRow({ outputStyle: claudeRow()["outputStyle"] }))).toBe(false);
    expect(listReply(claudeRow({ terminalSessionsReachable: true }))).toBe(false);
  });

  it("keeps the compaction bound on a step of five between the provider's own stops", () => {
    expect(
      listReply(claudeRow({ autoCompactPercent: { value: 82, lowest: 50, highest: 95 } })),
    ).toBe(false);
    expect(
      listReply(claudeRow({ autoCompactPercent: { value: 45, lowest: 50, highest: 95 } })),
    ).toBe(false);
  });

  it("offers only an output style the installed build lists", () => {
    expect(
      listReply(claudeRow({ outputStyle: { current: "Concise", styles: [{ name: "default" }] } })),
    ).toBe(false);
  });
});

describe("provider.update", () => {
  it("changes exactly one setting per press", () => {
    expect(
      ProviderUpdateRequestSchema.safeParse({ provider: "claude", helpersAtOnce: 3 }).success,
    ).toBe(true);
    expect(
      ProviderUpdateRequestSchema.safeParse({ provider: "claude", helpersAtOnce: null }).success,
    ).toBe(true);
    expect(
      ProviderUpdateRequestSchema.safeParse({ provider: "codex", commandPath: null }).success,
    ).toBe(true);
    expect(ProviderUpdateRequestSchema.safeParse({ provider: "claude" }).success).toBe(false);
    expect(
      ProviderUpdateRequestSchema.safeParse({
        provider: "claude",
        helpersAtOnce: 3,
        availableForNewSessions: false,
      }).success,
    ).toBe(false);
  });

  it("refuses a knob the named provider does not have", () => {
    expect(
      ProviderUpdateRequestSchema.safeParse({ provider: "claude", outputStyle: "Learning" })
        .success,
    ).toBe(true);
    expect(
      ProviderUpdateRequestSchema.safeParse({ provider: "codex", outputStyle: "Learning" }).success,
    ).toBe(false);
    expect(
      ProviderUpdateRequestSchema.safeParse({ provider: "codex", terminalSessionsReachable: false })
        .success,
    ).toBe(true);
    expect(
      ProviderUpdateRequestSchema.safeParse({
        provider: "claude",
        terminalSessionsReachable: false,
      }).success,
    ).toBe(false);
  });
});
