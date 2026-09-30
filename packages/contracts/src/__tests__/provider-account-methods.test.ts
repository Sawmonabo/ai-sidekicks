// `providerAccount.*` update, remove, set-current, probe and usage: a set-current success reply
// names the account it made current, no request lets a caller assert the daemon-owned credential
// generation, and usage is answered in whole micro-dollars.
import { describe, expect, it } from "vitest";
import type { z } from "zod";

import {
  PROVIDER_ACCOUNT_WIRE_SHAPES,
  ProviderAccountProbeRequestSchema,
  ProviderAccountProbeResponseSchema,
  ProviderAccountRemoveRequestSchema,
  ProviderAccountRemoveResponseSchema,
  ProviderAccountSetCurrentRequestSchema,
  ProviderAccountSetCurrentResponseSchema,
  ProviderAccountUpdateRequestSchema,
  ProviderAccountUpdateResponseSchema,
  ProviderAccountUsageReadResponseSchema,
} from "../provider-account-methods.js";
import { ProviderAccountRegisterRequestSchema } from "../provider-account-sign-in.js";

const ACCOUNT_ID = "acct_01J8XYZ";
const TIMESTAMP = "2026-08-31T00:00:00.000Z";
const SESSION_ID = "0192f3a1-4b5c-7d8e-9f01-23456789abcd";
const SESSION_ID_2 = "0192f3a1-4b5c-7d8e-9f01-23456789abce";

function validAccount(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    accountId: ACCOUNT_ID,
    provider: "claude",
    displayLabel: "Personal",
    credentialGeneration: 1,
    billingMode: "subscription",
    isDefault: true,
    healthState: "authenticated",
    healthObservedAt: TIMESTAMP,
    observedAuthMode: "oauth_subscription",
    loggedInAt: TIMESTAMP,
    lastRefreshObservedAt: null,
    expectedReloginAtEstimate: null,
    probeEnabled: true,
    windowStartEnabled: true,
    wakeForWindowStartEnabled: false,
    memoryImport: null,
    ...overrides,
  };
}

describe("request/response pairs", () => {
  it("refuses a set-current success reply whose account is not the default", () => {
    expect(
      ProviderAccountUpdateRequestSchema.safeParse({ accountId: ACCOUNT_ID, probeEnabled: false })
        .success,
    ).toBe(true);
    expect(ProviderAccountUpdateResponseSchema.safeParse({ account: validAccount() }).success).toBe(
      true,
    );

    expect(ProviderAccountRemoveRequestSchema.safeParse({ accountId: ACCOUNT_ID }).success).toBe(
      true,
    );
    expect(
      ProviderAccountRemoveResponseSchema.safeParse({ accountId: ACCOUNT_ID, removed: true })
        .success,
    ).toBe(true);

    expect(
      ProviderAccountSetCurrentRequestSchema.safeParse({ accountId: ACCOUNT_ID }).success,
    ).toBe(true);
    expect(
      ProviderAccountSetCurrentResponseSchema.safeParse({
        account: validAccount(),
        movingSessions: [
          { sessionId: SESSION_ID, appliesAt: "immediately" },
          { sessionId: SESSION_ID_2, appliesAt: "next_tool_call" },
        ],
      }).success,
    ).toBe(true);
    // The verb has no partial success: `isDefault: false` on a success reply would be a refusal
    // in a success envelope, and every real refusal here is a typed error. It is a refinement,
    // not a narrower type, because the account projection is shared.
    expect(
      ProviderAccountSetCurrentResponseSchema.safeParse({
        account: validAccount({ isDefault: false }),
        movingSessions: [],
      }).success,
    ).toBe(false);
    // The shared projection stays wide: other replies still admit a non-default account.
    expect(
      ProviderAccountUpdateResponseSchema.safeParse({ account: validAccount({ isDefault: false }) })
        .success,
    ).toBe(true);

    expect(ProviderAccountProbeRequestSchema.safeParse({ accountId: ACCOUNT_ID }).success).toBe(
      true,
    );
    expect(
      ProviderAccountProbeResponseSchema.safeParse({
        accountId: ACCOUNT_ID,
        healthState: "indeterminate",
        credentialGeneration: 1,
      }).success,
    ).toBe(true);
  });

  it("refuses a caller-asserted credential generation on the register request", () => {
    // `credentialGeneration` is daemon-owned: a caller that could assert one could pass off a
    // stale quota reading or superseded attention epoch as current.
    expect(
      ProviderAccountRegisterRequestSchema.safeParse({
        provider: "claude",
        displayLabel: "Personal",
        billingMode: "subscription",
        credentialGeneration: 7,
      }).success,
    ).toBe(false);
    // Nor on any other request shape.
    for (const wireShape of PROVIDER_ACCOUNT_WIRE_SHAPES) {
      if (wireShape.direction !== "request") {
        continue;
      }
      expect(
        collectMemberNames(wireShape.schema),
        `\`${wireShape.name}\` exposes a caller-settable credential generation`,
      ).not.toContain("credentialGeneration");
    }
  });
});

/**
 * Every member name reachable from a schema, at any nesting depth. It walks the runtime `def`
 * rather than the TypeScript type, so members inside array elements, union arms and optional
 * wrappers are counted.
 */
function collectMemberNames(schema: z.ZodType<unknown>): readonly string[] {
  const memberNames: string[] = [];
  const seen = new Set<unknown>();

  function walk(node: unknown): void {
    if (node === null || typeof node !== "object" || seen.has(node)) {
      return;
    }
    seen.add(node);
    const definition = (node as { def?: Record<string, unknown> }).def;
    if (definition === undefined) {
      return;
    }
    const shape = definition["shape"];
    if (shape !== undefined && typeof shape === "object" && shape !== null) {
      for (const [memberName, memberSchema] of Object.entries(shape)) {
        memberNames.push(memberName);
        walk(memberSchema);
      }
    }
    for (const wrapperKey of ["innerType", "element", "valueType", "keyType", "in", "out"]) {
      walk(definition[wrapperKey]);
    }
    const options = definition["options"];
    if (Array.isArray(options)) {
      for (const option of options) {
        walk(option);
      }
    }
  }

  walk(schema);
  return memberNames;
}

describe("the usage read", () => {
  it("answers usage in whole micro-dollars, refusing a fraction of one", () => {
    const row = { model: "claude-opus-4-1", tokens: 1200, costUsdMicros: 18_450 };
    expect(ProviderAccountUsageReadResponseSchema.safeParse({ rows: [row] }).success).toBe(true);
    expect(
      ProviderAccountUsageReadResponseSchema.safeParse({ rows: [{ ...row, costUsdMicros: 0.5 }] })
        .success,
    ).toBe(false);
  });
});
