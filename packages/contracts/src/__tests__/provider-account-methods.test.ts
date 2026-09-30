// `providerAccount.*` update, remove, set-current, probe and usage: every wire shape refuses an
// unknown key, neither set-current nor remove admits a partial success, no request lets a caller
// assert the daemon-owned credential generation, and usage is answered in whole micro-dollars.
// Credential material crosses the wire on exactly one request member and on no response or
// notification, counted over every shape in `PROVIDER_ACCOUNT_WIRE_SHAPES`.
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

  it("refuses an unknown key on every request, response, and notification shape", () => {
    // Asserted over the registry so a later shape cannot be added non-strict unnoticed. Each arm
    // of a union is probed on its own, and the refusal must name the unknown key: a shape with a
    // required member would refuse the probe for that member alone.
    for (const wireShape of PROVIDER_ACCOUNT_WIRE_SHAPES) {
      for (const arm of unionArmsOf(wireShape.schema)) {
        const probe = arm.safeParse({ smuggledMember: "x" });
        const unknownKeyIssues = (probe.error?.issues ?? []).filter(
          (issue) => issue.code === "unrecognized_keys",
        );
        expect(unknownKeyIssues, `\`${wireShape.name}\` accepted an unknown key`).not.toEqual([]);
      }
    }
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

  it("refuses a partial success on the remove response", () => {
    // `removed: false` would be a refusal in a success envelope; refusals here are typed errors.
    expect(
      ProviderAccountRemoveResponseSchema.safeParse({ accountId: ACCOUNT_ID, removed: false })
        .success,
    ).toBe(false);
  });
});

/** The arms of a union, flattened; any other schema is its own single arm. */
function unionArmsOf(schema: z.ZodType<unknown>): readonly z.ZodType<unknown>[] {
  const options = (schema as { def?: { options?: unknown } }).def?.options;
  return Array.isArray(options)
    ? options.flatMap((option: z.ZodType<unknown>) => unionArmsOf(option))
    : [schema];
}

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

// Member names that could carry credential material. Narrower than "credential":
// `credentialHomePath` and `credentialGeneration` are non-secret, and `tokens` alone is a usage
// count.
const CREDENTIAL_SHAPED_MEMBER =
  /(token(?!s$)|secret|password|passphrase|api_?key|private_?key|cookie|bearer)/i;

function credentialShapedMembersOf(schema: z.ZodType<unknown>): readonly string[] {
  return collectMemberNames(schema).filter((memberName) =>
    CREDENTIAL_SHAPED_MEMBER.test(memberName),
  );
}

describe("one credential-accepting input, zero credential-bearing outputs", () => {
  it("counts exactly one credential-accepting input, and names it", () => {
    const credentialInputs = PROVIDER_ACCOUNT_WIRE_SHAPES.filter(
      (wireShape) => wireShape.direction === "request",
    ).flatMap((wireShape) =>
      credentialShapedMembersOf(wireShape.schema).map(
        (memberName) => `${wireShape.name}.${memberName}`,
      ),
    );
    expect(credentialInputs).toEqual(["ProviderAccountRegisterRequest.nonInteractiveToken"]);
    // The count is taken over a shape that also carries the re-supply selector, so "exactly
    // one" is shown insensitive to `accountId`.
    expect(collectMemberNames(ProviderAccountRegisterRequestSchema)).toContain("accountId");
  });

  it("counts zero credential-bearing outputs across every response and notification", () => {
    const credentialOutputs = PROVIDER_ACCOUNT_WIRE_SHAPES.filter(
      (wireShape) => wireShape.direction !== "request",
    ).flatMap((wireShape) =>
      credentialShapedMembersOf(wireShape.schema).map(
        (memberName) => `${wireShape.name}.${memberName}`,
      ),
    );
    expect(credentialOutputs).toEqual([]);
  });
});

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
