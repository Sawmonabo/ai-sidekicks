// `providerAccount.*` coverage for update, remove, set-current, probe and usage, plus the
// credential census: the subject set is derived from `PROVIDER_ACCOUNT_WIRE_SHAPES` and
// cross-checked against the three provider-account modules' exports, so a shape added later is
// either censused or caught. The error channel, whose `fields` is `Record<string, unknown>`,
// is censused by member name and by value against the token fixture. Each part has a negative
// control showing the checker can fail.
import { describe, expect, it } from "vitest";
import type { z } from "zod";

import type { JsonRpcErrorData } from "../jsonrpc.js";
import * as providerAccountMethodsModule from "../provider-account-methods.js";
import * as providerAccountSignInModule from "../provider-account-sign-in.js";
import * as providerAccountModule from "../provider-account.js";

import {
  PROVIDER_ACCOUNT_WIRE_SHAPES,
  ProviderAccountInUseDetailsSchema,
  ProviderAccountProbeRequestSchema,
  ProviderAccountProbeResponseSchema,
  ProviderAccountRemoveRequestSchema,
  ProviderAccountRemoveResponseSchema,
  ProviderAccountSetCurrentRequestSchema,
  ProviderAccountSetCurrentResponseSchema,
  ProviderAccountUpdateRequestSchema,
  ProviderAccountUpdateResponseSchema,
  ProviderAccountUsageReadRequestSchema,
  ProviderAccountUsageReadResponseSchema,
} from "../provider-account-methods.js";
import {
  PROVIDER_ACCOUNT_REDACTED_WIRE_MEMBERS,
  ProviderAccountRegisterRequestSchema,
  ProviderAccountRegisterResponseSchema,
} from "../provider-account-sign-in.js";
import {
  ProviderAccountListResponseSchema,
  ProviderAccountNotificationSchema,
} from "../provider-account.js";

const ACCOUNT_ID = "acct_01J8XYZ";
const TIMESTAMP = "2026-08-31T00:00:00.000Z";
const SESSION_ID = "0192f3a1-4b5c-7d8e-9f01-23456789abcd";
const SESSION_ID_2 = "0192f3a1-4b5c-7d8e-9f01-23456789abce";
/** The one credential value this plane accepts, so the error-envelope census can scan by value. */
const TOKEN_FIXTURE = "sk-example-token";

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
  it("accepts each account-changing pair at its canonical shape", () => {
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
    // Asserted over the derived registry so a later shape cannot be added non-strict unnoticed.
    for (const wireShape of PROVIDER_ACCOUNT_WIRE_SHAPES) {
      const probe = wireShape.schema.safeParse({ smuggledMember: "x" });
      expect(probe.success, `\`${wireShape.name}\` accepted an unknown key`).toBe(false);
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

/**
 * The schema walker's questions asked of a plain JSON value, since `JsonRpcErrorData.fields` has
 * no schema to walk. Both helpers go to any depth: a mapper that spread a whole request into
 * `fields` would bury the member one level down.
 */
function credentialShapedKeysDeep(value: unknown): readonly string[] {
  const found: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node === null || typeof node !== "object") {
      return;
    }
    for (const [key, nested] of Object.entries(node)) {
      if (CREDENTIAL_SHAPED_MEMBER.test(key)) {
        found.push(key);
      }
      visit(nested);
    }
  };
  visit(value);
  return found;
}

function stringValuesDeep(value: unknown): readonly string[] {
  const found: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      found.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node !== null && typeof node === "object") {
      Object.values(node).forEach(visit);
    }
  };
  visit(value);
  return found;
}

describe("one credential-accepting input, zero credential-bearing outputs", () => {
  it("registers every request, response, and notification schema the module exports", () => {
    // A shape added without a registry entry fails here instead of escaping every count below.
    const providerAccountModules: Record<string, unknown> = {
      ...providerAccountModule,
      ...providerAccountSignInModule,
      ...providerAccountMethodsModule,
    };
    const exportedWireSchemaNames = Object.keys(providerAccountModules)
      .filter((exportName) => /(Request|Response|Notification)Schema$/.test(exportName))
      .map((exportName) => exportName.replace(/Schema$/, ""))
      .sort();
    const registeredNames = PROVIDER_ACCOUNT_WIRE_SHAPES.map((wireShape) => wireShape.name).sort();
    expect(registeredNames).toEqual(exportedWireSchemaNames);
    // Each entry points at the schema it names, so a copy-paste that registered a shape twice
    // cannot pass.
    for (const wireShape of PROVIDER_ACCOUNT_WIRE_SHAPES) {
      expect(
        providerAccountModules[`${wireShape.name}Schema`],
        `\`${wireShape.name}\` registry entry does not point at its own schema`,
      ).toBe(wireShape.schema);
    }
    expect(new Set(registeredNames).size).toBe(registeredNames.length);
  });

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

  it("detects a credential-shaped member at any depth (negative control)", () => {
    // Without this, both counts above would be consistent with a walker that never descended.
    // Each fixture hides the member one layer deeper than the last.
    const nestedInAnObject = ProviderAccountRegisterResponseSchema;
    expect(credentialShapedMembersOf(nestedInAnObject)).toEqual([]);
    expect(collectMemberNames(nestedInAnObject)).toContain("displayLabel");

    // Inside an array element (`accounts`).
    expect(collectMemberNames(ProviderAccountListResponseSchema)).toContain("usedPercent");
    // Inside a union arm (the readiness remedy).
    expect(collectMemberNames(ProviderAccountListResponseSchema)).toContain("signInInvocation");
    // Inside a discriminated union arm (the notification).
    expect(collectMemberNames(ProviderAccountNotificationSchema)).toContain("failureReason");

    // Reachable only through shapes with a cross-field `.superRefine`, which returns the object
    // schema itself. If it ever wrapped instead, the walker would stop at the wrapper and the
    // counts above would go vacuous for exactly those shapes; a refined shape wrapping another
    // refined one (set-current) fails first.
    expect(collectMemberNames(ProviderAccountSetCurrentResponseSchema)).toContain("displayLabel");
    expect(collectMemberNames(ProviderAccountNotificationSchema)).toContain("usedPercent");

    // The detector fires on each name it is meant to catch.
    for (const forbidden of [
      "refreshToken",
      "clientSecret",
      "password",
      "apiKey",
      "api_key",
      "privateKey",
      "sessionCookie",
      "bearerToken",
    ]) {
      expect(CREDENTIAL_SHAPED_MEMBER.test(forbidden), `\`${forbidden}\` was not flagged`).toBe(
        true,
      );
    }
    // Non-secret members are not flagged, which keeps the census from being relaxed away.
    // `accountId` is the one other member the register request accepts.
    for (const permitted of [
      "credentialHomePath",
      "credentialGeneration",
      "attemptId",
      "accountId",
    ]) {
      expect(CREDENTIAL_SHAPED_MEMBER.test(permitted), `\`${permitted}\` was wrongly flagged`).toBe(
        false,
      );
    }
  });

  it("marks exactly the credential-accepting member for transport redaction", () => {
    expect([...PROVIDER_ACCOUNT_REDACTED_WIRE_MEMBERS]).toEqual(["nonInteractiveToken"]);
    // A redaction list that drifted from the wire would leave a new credential member logged.
    const censusedInputMembers = PROVIDER_ACCOUNT_WIRE_SHAPES.filter(
      (wireShape) => wireShape.direction === "request",
    ).flatMap((wireShape) => credentialShapedMembersOf(wireShape.schema));
    expect([...PROVIDER_ACCOUNT_REDACTED_WIRE_MEMBERS].sort()).toEqual(
      [...new Set(censusedInputMembers)].sort(),
    );
  });

  it("keeps the token member off every response and notification shape by name", () => {
    for (const wireShape of PROVIDER_ACCOUNT_WIRE_SHAPES) {
      if (wireShape.direction === "request") {
        continue;
      }
      for (const redactedMember of PROVIDER_ACCOUNT_REDACTED_WIRE_MEMBERS) {
        expect(
          collectMemberNames(wireShape.schema),
          `\`${wireShape.name}\` carries the write-only member \`${redactedMember}\``,
        ).not.toContain(redactedMember);
      }
    }
  });

  it("carries the credential input on exactly one request shape", () => {
    const carryingShapes = PROVIDER_ACCOUNT_WIRE_SHAPES.filter((wireShape) =>
      collectMemberNames(wireShape.schema).includes("nonInteractiveToken"),
    ).map((wireShape) => wireShape.name);
    expect(carryingShapes).toEqual(["ProviderAccountRegisterRequest"]);
  });

  // The error channel. A `provideraccount.*` refusal travels as `JsonRpcErrorData`, whose
  // `fields` is `Record<string, unknown>`, so no schema census reaches it: a mapper that spread
  // the register request into `fields` would pass every count above while logging the token.
  // Representative refusal envelopes are scanned by member name with the wire census's detector
  // and by value against the token fixture. The value scan matters for
  // `provideraccount.token_class_refused`, which names the failed condition and never quotes the
  // supplied value, so a field innocently called `supplied` carrying the token is caught. The
  // envelope list is enumerated by hand, so a new code without a fixture here is not caught.
  const PROVIDER_ACCOUNT_REFUSAL_ENVELOPES: ReadonlyArray<JsonRpcErrorData> = [
    { type: "provideraccount.not_registered", fields: { provider: "claude" } },
    { type: "provideraccount.no_default", fields: { provider: "claude" } },
    { type: "provideraccount.unknown", fields: { providerAccountId: ACCOUNT_ID } },
    {
      type: "provideraccount.credential_home_unavailable",
      fields: { providerAccountId: ACCOUNT_ID },
    },
    {
      type: "provideraccount.not_authenticated",
      fields: { providerAccountId: ACCOUNT_ID, healthState: "indeterminate" },
    },
    { type: "provideraccount.permission_denied", fields: { providerAccountId: ACCOUNT_ID } },
    {
      type: "provideraccount.default_conflict",
      fields: { provider: "claude", providerAccountId: ACCOUNT_ID },
    },
    { type: "provideraccount.signin_unsupported", fields: { provider: "codex" } },
    {
      type: "provideraccount.signin_in_flight",
      fields: { providerAccountId: ACCOUNT_ID, attemptId: "att_01J8" },
    },
    // Names the failed condition; never carries, quotes or excerpts the value that failed it.
    {
      type: "provideraccount.token_class_refused",
      fields: { provider: "claude", failedCondition: "not_a_vendor_minted_non_interactive_token" },
    },
    { type: "provideraccount.credential_seal_refused", fields: { provider: "claude" } },
    {
      type: "provideraccount.provider_version_below_floor",
      fields: { provider: "codex", observedVersion: "0.140.0", requiredVersion: "0.149.1" },
    },
  ];

  it("carries no credential-shaped member on any provider-account refusal envelope", () => {
    for (const envelope of PROVIDER_ACCOUNT_REFUSAL_ENVELOPES) {
      expect(
        credentialShapedKeysDeep(envelope.fields),
        `\`${envelope.type}\` carries a credential-shaped member`,
      ).toEqual([]);
    }
  });

  it("never echoes the supplied token value back through the error channel", () => {
    for (const envelope of PROVIDER_ACCOUNT_REFUSAL_ENVELOPES) {
      for (const value of stringValuesDeep(envelope.fields)) {
        expect(
          value.includes(TOKEN_FIXTURE),
          `\`${envelope.type}\` echoes the supplied token value`,
        ).toBe(false);
      }
    }
  });

  it("catches a forced error that carries the token, by name and by value", () => {
    // Without this, both counts above would be consistent with walkers that never descended.
    // Case 1: the whole request spread into `fields`, so the member sits one level down.
    const spreadRequest: JsonRpcErrorData = {
      type: "provideraccount.token_class_refused",
      fields: {
        provider: "claude",
        request: { accountId: ACCOUNT_ID, nonInteractiveToken: TOKEN_FIXTURE },
      },
    };
    expect(credentialShapedKeysDeep(spreadRequest.fields)).toEqual(["nonInteractiveToken"]);

    // Case 2: the refusal quotes what it refused under an innocent member name, which only the
    // value scan sees.
    const quotedValue: JsonRpcErrorData = {
      type: "provideraccount.token_class_refused",
      fields: { provider: "claude", supplied: [`rejected: ${TOKEN_FIXTURE}`] },
    };
    expect(credentialShapedKeysDeep(quotedValue.fields)).toEqual([]);
    expect(
      stringValuesDeep(quotedValue.fields).some((value) => value.includes(TOKEN_FIXTURE)),
    ).toBe(true);

    // Naming the input in prose is not echoing it, so the value scan stays quiet.
    const namesTheMember: JsonRpcErrorData = {
      type: "provideraccount.token_class_refused",
      fields: { provider: "claude", failedCondition: "nonInteractiveToken must be vendor-minted" },
    };
    expect(
      stringValuesDeep(namesTheMember.fields).some((value) => value.includes(TOKEN_FIXTURE)),
    ).toBe(false);
  });

  it("covers every provider-account refusal code exactly once", () => {
    const codes = PROVIDER_ACCOUNT_REFUSAL_ENVELOPES.map((envelope) => envelope.type);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toHaveLength(12);
    for (const code of codes) {
      expect(code.startsWith("provideraccount."), `\`${code}\` is not on this plane`).toBe(true);
    }
    // The write-only member never appears in an envelope, checked against the same marking the
    // wire census uses.
    for (const redactedMember of PROVIDER_ACCOUNT_REDACTED_WIRE_MEMBERS) {
      for (const envelope of PROVIDER_ACCOUNT_REFUSAL_ENVELOPES) {
        expect(
          Object.keys(envelope.fields ?? {}),
          `\`${envelope.type}\` carries the write-only member \`${redactedMember}\``,
        ).not.toContain(redactedMember);
      }
    }
  });
});

describe("the account switch, the memory import, the usage read and their refusals", () => {
  it("says when each moved session moves, in the closed pair", () => {
    expect(
      ProviderAccountSetCurrentResponseSchema.safeParse({
        account: validAccount(),
        movingSessions: [{ sessionId: SESSION_ID, appliesAt: "turn_boundary" }],
      }).success,
    ).toBe(false);
  });

  it("reads usage for one account or one provider, never both", () => {
    expect(
      ProviderAccountUsageReadRequestSchema.safeParse({
        scope: { accountId: ACCOUNT_ID },
        from: TIMESTAMP,
        groupBy: "model",
      }).success,
    ).toBe(true);
    expect(
      ProviderAccountUsageReadRequestSchema.safeParse({ scope: { provider: "codex" } }).success,
    ).toBe(true);
    expect(
      ProviderAccountUsageReadRequestSchema.safeParse({
        scope: { accountId: ACCOUNT_ID, provider: "claude" },
      }).success,
    ).toBe(false);
    expect(
      ProviderAccountUsageReadRequestSchema.safeParse({
        scope: { provider: "claude" },
        groupBy: "week",
      }).success,
    ).toBe(false);
  });

  it("answers usage in whole micro-dollars, refusing a fraction of one", () => {
    const row = { model: "claude-opus-4-1", tokens: 1200, costUsdMicros: 18_450 };
    expect(ProviderAccountUsageReadResponseSchema.safeParse({ rows: [row] }).success).toBe(true);
    expect(
      ProviderAccountUsageReadResponseSchema.safeParse({ rows: [{ ...row, costUsdMicros: 0.5 }] })
        .success,
    ).toBe(false);
  });

  it("carries the window-start switches and the wake helper's reason when it did not install", () => {
    expect(
      ProviderAccountUpdateRequestSchema.safeParse({
        accountId: ACCOUNT_ID,
        windowStartEnabled: false,
        wakeForWindowStartEnabled: true,
      }).success,
    ).toBe(true);
    expect(
      ProviderAccountUpdateResponseSchema.safeParse({
        account: validAccount(),
        wakeHelper: { state: "notInstalled", reason: "The administrator password was refused." },
      }).success,
    ).toBe(true);
    expect(
      ProviderAccountUpdateResponseSchema.safeParse({
        account: validAccount(),
        wakeHelper: { state: "notInstalled" },
      }).success,
    ).toBe(false);
  });

  it("names at least one session when it refuses to remove an account in use", () => {
    expect(ProviderAccountInUseDetailsSchema.safeParse({ sessionIds: [SESSION_ID] }).success).toBe(
      true,
    );
    expect(ProviderAccountInUseDetailsSchema.safeParse({ sessionIds: [] }).success).toBe(false);
  });
});
