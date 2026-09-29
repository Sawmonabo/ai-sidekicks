// The provider-settings wire: what `provider.list` reads per provider, what one
// `provider.update` may change, and the shapes the protected paths, the standing
// rules and the install stream carry.
import { describe, expect, it } from "vitest";

import {
  ProviderInstallProgressSchema,
  ProviderListResponseSchema,
  ProviderProtectedPathSchema,
  ProviderStandingRuleRevokeResponseSchema,
  ProviderStandingRuleSchema,
  ProviderTerminalPluginUpdateRequestSchema,
  ProviderUpdateRequestSchema,
} from "../provider.js";

const REPO_MOUNT_ID = "0192f3a1-4b5c-7d8e-9f01-23456789abcd";

function claudeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: "claude",
    installation: { state: "installed", version: "2.1.271" },
    commandPath: null,
    availableForNewSessions: true,
    helpersAtOnce: 0,
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

  it("names the needed version on a command that is too old", () => {
    expect(listReply(codexRow({ installation: { state: "tooOld", version: "0.140.0" } }))).toBe(
      false,
    );
  });
});

describe("provider.update", () => {
  it("changes exactly one setting per press", () => {
    expect(
      ProviderUpdateRequestSchema.safeParse({ provider: "claude", helpersAtOnce: 3 }).success,
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

  it("moves the compaction bound in steps of five", () => {
    expect(
      ProviderUpdateRequestSchema.safeParse({ provider: "codex", autoCompactPercent: 85 }).success,
    ).toBe(true);
    expect(
      ProviderUpdateRequestSchema.safeParse({ provider: "codex", autoCompactPercent: 83 }).success,
    ).toBe(false);
  });

  it("puts the terminal plugin into Claude Code only", () => {
    expect(
      ProviderTerminalPluginUpdateRequestSchema.safeParse({ provider: "claude", enabled: true })
        .success,
    ).toBe(true);
    expect(
      ProviderTerminalPluginUpdateRequestSchema.safeParse({ provider: "codex", enabled: true })
        .success,
    ).toBe(false);
  });
});

describe("protected paths and standing rules", () => {
  it("says where each protected path came from", () => {
    expect(
      ProviderProtectedPathSchema.safeParse({ pattern: "~/.aws/credentials", source: "builtIn" })
        .success,
    ).toBe(true);
    expect(
      ProviderProtectedPathSchema.safeParse({
        pattern: "secrets/**",
        source: "project",
        sourcePath: "/work/app/.claude/settings.json",
        repoMountId: REPO_MOUNT_ID,
      }).success,
    ).toBe(true);
    // A project's deny rule names its project; a built-in one has no file.
    expect(
      ProviderProtectedPathSchema.safeParse({
        pattern: "secrets/**",
        source: "project",
        sourcePath: "/work/app/.claude/settings.json",
      }).success,
    ).toBe(false);
    expect(
      ProviderProtectedPathSchema.safeParse({
        pattern: "~/.aws/credentials",
        source: "builtIn",
        sourcePath: "/somewhere",
      }).success,
    ).toBe(false);
  });

  it("carries each standing rule's scope and source file in the provider's own words", () => {
    const rule = {
      ruleId: "rule_7f3a",
      scope: { kind: "accountHome", accountId: "acct_01J8XYZ" },
      sourcePath: "/Users/person/.ai-sidekicks/accounts/acct_01J8XYZ/rules/default.rules",
      decision: "allow",
      text: 'prefix_rule(pattern=["git", "status"], decision="allow")',
    };
    expect(ProviderStandingRuleSchema.safeParse(rule).success).toBe(true);
    expect(
      ProviderStandingRuleSchema.safeParse({
        ...rule,
        scope: { kind: "project", repoMountId: REPO_MOUNT_ID },
      }).success,
    ).toBe(true);
    expect(
      ProviderStandingRuleSchema.safeParse({ ...rule, scope: { kind: "session" } }).success,
    ).toBe(false);
    expect(
      ProviderStandingRuleRevokeResponseSchema.safeParse({ ruleId: "rule_7f3a", outcome: "kept" })
        .success,
    ).toBe(false);
  });
});

describe("provider.installSubscribe", () => {
  it("carries the installer's reason and its command on a failed install", () => {
    expect(
      ProviderInstallProgressSchema.safeParse({ provider: "codex", state: "running" }).success,
    ).toBe(true);
    expect(
      ProviderInstallProgressSchema.safeParse({
        provider: "claude",
        state: "failed",
        reason: "curl: (6) Could not resolve host: claude.ai",
        command: "curl -fsSL https://claude.ai/install.sh | bash",
      }).success,
    ).toBe(true);
    expect(
      ProviderInstallProgressSchema.safeParse({
        provider: "claude",
        state: "failed",
        reason: "curl: (6) Could not resolve host: claude.ai",
      }).success,
    ).toBe(false);
  });
});
