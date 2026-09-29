// `providerAccount.*` coverage for the remaining methods and the credential
// census.
//
//   1. Per-pair acceptance and rejection rows for update, remove, set-current and
//      probe, plus the unknown-key refusal that `.strict()` buys on every shape.
//   2. The census DERIVES its subject set from `PROVIDER_ACCOUNT_WIRE_SHAPES` and
//      cross-checks that registry against the three provider-account modules'
//      own exports, so a shape added later is either censused or caught. It
//      closes with the fourth direction the schema registry cannot reach — the
//      ERROR channel, whose `fields` is `Record<string, unknown>` — by censusing
//      representative refusal envelopes both by member name and by value against
//      the token fixture. Every part of it carries a negative control, because a
//      checker that has never been shown to fail proves nothing about a clean
//      result.
//   3. The account switch, the memory import, the usage read and their refusals.
//
import { describe, expect, it } from "vitest";
import type { z } from "zod";

import type { JsonRpcErrorData } from "../jsonrpc.js";
import * as providerAccountMethodsModule from "../provider-account-methods.js";
import * as providerAccountSignInModule from "../provider-account-sign-in.js";
import * as providerAccountModule from "../provider-account.js";

import {
  PROVIDER_ACCOUNT_WIRE_SHAPES,
  ProviderAccountInUseDetailsSchema,
  ProviderAccountMemoryImportResponseSchema,
  ProviderAccountProbeRequestSchema,
  ProviderAccountProbeResponseSchema,
  ProviderAccountRemoveRequestSchema,
  ProviderAccountRemoveResponseSchema,
  ProviderAccountSetCurrentRequestSchema,
  ProviderAccountSetCurrentResponseSchema,
  ProviderAccountUpdateRequestSchema,
  ProviderAccountUpdateResponseSchema,
  ProviderAccountUsageReadRequestSchema,
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
/**
 * The one credential value this plane accepts, named once so the error-envelope
 * census below can scan for it BY VALUE and not only by member name.
 */
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
    expectedReloginAtEstimate: null,
    probeEnabled: true,
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
    // The verb's whole effect is on this member, and it has no partial success:
    // `isDefault: false` on a SUCCESS reply would be a refusal wearing a success
    // envelope, while every real refusal on this verb is a typed error
    // (`provideraccount.unknown`, `permission_denied`, `default_conflict`). The
    // sibling `ProviderAccountRemoveResponse.removed` makes the same argument
    // with `z.literal(true)`; this one is a refinement because the account
    // projection is shared and narrowing the type here would fork it.
    expect(
      ProviderAccountSetCurrentResponseSchema.safeParse({
        account: validAccount({ isDefault: false }),
        movingSessions: [],
      }).success,
    ).toBe(false);
    // And the shared projection is NOT narrowed by that pin: every other reply
    // returning an account still admits a non-default one, which is the reading
    // a list of accounts is made of.
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
    // `.strict()` everywhere, asserted over the derived registry rather than
    // shape by shape, so a later shape cannot be added non-strict unnoticed.
    for (const wireShape of PROVIDER_ACCOUNT_WIRE_SHAPES) {
      const probe = wireShape.schema.safeParse({ smuggledMember: "x" });
      expect(probe.success, `\`${wireShape.name}\` accepted an unknown key`).toBe(false);
    }
  });

  it("refuses a caller-asserted credential generation on the register request", () => {
    // `credentialGeneration` is daemon-owned and appears on NO request: a caller
    // that could assert one could assert that a stale quota reading or a
    // superseded attention epoch is current.
    expect(
      ProviderAccountRegisterRequestSchema.safeParse({
        provider: "claude",
        displayLabel: "Personal",
        billingMode: "subscription",
        credentialGeneration: 7,
      }).success,
    ).toBe(false);
    // Nor on any other request shape in the module.
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
    // `removed: false` would be a refusal wearing a success envelope; every
    // refusal on this verb is a typed error instead.
    expect(
      ProviderAccountRemoveResponseSchema.safeParse({ accountId: ACCOUNT_ID, removed: false })
        .success,
    ).toBe(false);
  });
});

// --------------------------------------------------------------------------
// --------------------------------------------------------------------------

/**
 * Every member name reachable from a schema, at any nesting depth.
 *
 * Walking the runtime `def` rather than the exported TypeScript type is what
 * makes this a census of the WIRE and not of a hand-maintained list: a member
 * nested inside an array element, a union arm, or an optional wrapper is
 * reachable by a producer and is therefore reachable here.
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

/**
 * Member names that could carry credential MATERIAL. Deliberately narrower than
 * "anything mentioning credentials": `credentialHomePath` and
 * `credentialGeneration` are legitimate non-secret members, so matching the bare
 * word `credential` would make the census cry wolf and be relaxed into
 * uselessness the first time it did.
 */
// `tokens` alone is a usage count (how many model tokens a turn spent), not a
// credential, so the bare plural is the one spelling of `token` left out.
const CREDENTIAL_SHAPED_MEMBER =
  /(token(?!s$)|secret|password|passphrase|api_?key|private_?key|cookie|bearer)/i;

function credentialShapedMembersOf(schema: z.ZodType<unknown>): readonly string[] {
  return collectMemberNames(schema).filter((memberName) =>
    CREDENTIAL_SHAPED_MEMBER.test(memberName),
  );
}

/**
 * The same two questions the schema walker asks, asked of a plain JSON value —
 * which is what an error envelope is. `JsonRpcErrorData.fields` is
 * `Record<string, unknown>`, so there is no `def` to walk and no schema to
 * census: the subject has to be the value itself.
 *
 * Both go to any DEPTH, because a mapper that spread a whole request object into
 * `fields` would bury the member one level down, which is the accident most
 * likely to happen and the one a top-level key check would miss.
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
    // The completeness check that keeps the census from going vacuous: a shape
    // added later without a registry entry fails HERE rather than silently
    // escaping every count below.
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
    // And each entry points at the schema it names, so a copy-paste that
    // registered one shape twice cannot pass.
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
    // And the count is taken over a shape that DOES carry the re-supply
    // selector, so "exactly one" is proven insensitive to `accountId` rather
    // than only measured on a request that happens not to accept it.
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
    // Without this, both counts above would be equally consistent with a walker
    // that never descended past the top level. Each fixture hides the member one
    // layer deeper than the last.
    const nestedInAnObject = ProviderAccountRegisterResponseSchema;
    expect(credentialShapedMembersOf(nestedInAnObject)).toEqual([]);
    expect(collectMemberNames(nestedInAnObject)).toContain("displayLabel");

    // A member nested inside an ARRAY element — the shape `accounts` uses.
    expect(collectMemberNames(ProviderAccountListResponseSchema)).toContain("usedPercent");
    // A member nested inside a UNION arm — the shape the readiness remedy uses.
    expect(collectMemberNames(ProviderAccountListResponseSchema)).toContain("signInInvocation");
    // A member nested inside a DISCRIMINATED union arm — the notification shape.
    expect(collectMemberNames(ProviderAccountNotificationSchema)).toContain("failureReason");

    // And a member reachable ONLY THROUGH a shape carrying a cross-field
    // refinement. FIVE shapes in this module refuse a contradictory combination
    // with `.superRefine`, which returns the object schema itself rather than
    // wrapping it; were that ever to change, the walker would stop at the
    // wrapper and every count above would silently go vacuous for exactly those
    // shapes. Each of the five is covered, and this is the enumeration:
    //   * `ProviderAccountRegisterRequestSchema` — covered by the
    //     `accountId` assertion in the exactly-one-input test above.
    //   * `ProviderAccountSchema` — reached THROUGH the refinement here, since
    //     `displayLabel` lives on the refined account nested in the register
    //     reply asserted at the top of this test.
    //   * `ProviderReadinessSchema` — `signInInvocation` is reachable only
    //     through the refined readiness entry inside the list reply, asserted
    //     above.
    //   * `ProviderAccountSetCurrentResponseSchema` — a refined shape wrapping
    //     another refined shape, so it is the case that fails first if either
    //     level ever starts wrapping.
    //   * the `usage_window_updated` notification arm — `usedPercent` lives
    //     inside it.
    expect(collectMemberNames(ProviderAccountSetCurrentResponseSchema)).toContain("displayLabel");
    expect(collectMemberNames(ProviderAccountNotificationSchema)).toContain("usedPercent");

    // And the detector itself fires on each of the names it is meant to catch.
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
    // While the legitimate non-secret members are NOT flagged — the
    // discrimination that keeps this census from being relaxed away.
    // `accountId` earns its place here: it is the one other member the register
    // request accepts, so the count of one below has to be insensitive to it.
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
    // The marking and the census must name the same member: a redaction list
    // that drifted from the wire would leave a new credential member logged.
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

  // --------------------------------------------------------------------------
  // The fourth direction: the error channel
  // --------------------------------------------------------------------------
  //
  // The census above walks requests, responses, and notifications, which is
  // every SCHEMA this module declares — and a `provideraccount.*` refusal is not
  // one of them. It travels as `JsonRpcErrorData`, whose `fields` is
  // `Record<string, unknown>`: an untyped hole no schema census can close,
  // because there is no schema to walk. A mapper that spread the register
  // request into `fields` would therefore pass every count above unchanged while
  // logging the token.
  //
  // What is censused instead is REPRESENTATIVE mapped envelopes: each code is
  // transcribed and each `fields` shape is composed to be consistent with that
  // row's prose rather than copied from it, because the doc declares the
  // permitted contents and does not exhibit an envelope. They are scanned two
  // ways: by member NAME with the same detector the wire census uses, and by
  // VALUE against the one token fixture this suite registers. The value scan is
  // the one that matters for `provideraccount.token_class_refused`, whose
  // normative rule is about the VALUE and not the name — "names which condition
  // failed and never quotes, echoes, or excerpts the supplied value" — so a
  // field innocently called `supplied` or `observed` carrying the token is
  // caught here and would not be caught by any name-based rule.
  //
  // Two limits, stated rather than papered over. The fixture set is ENUMERATED
  // BY HAND, so a code added to that doc without a fixture here is not caught;
  // and the binding enforcement is the daemon's error mapper, a later phase —
  // this pins the contract the mapper will be held to. Declaring the field names
  // as an exported registry is deliberately NOT done yet: its only consumer
  // would be this test, and a declaration minted ahead of its reader is the
  // vacuity this whole block exists to prevent.
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
    // The condition is NAMED; the value that failed it is not carried, quoted,
    // or excerpted — the one row in that table whose text is a rule about the
    // payload rather than a description of it.
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
    // Without this, both counts above would be equally consistent with walkers
    // that never descended and a fixture set that never contained a token.
    //
    // Case 1: the accident — the whole request spread into `fields`, so the
    // member sits one level down under its own name.
    const spreadRequest: JsonRpcErrorData = {
      type: "provideraccount.token_class_refused",
      fields: {
        provider: "claude",
        request: { accountId: ACCOUNT_ID, nonInteractiveToken: TOKEN_FIXTURE },
      },
    };
    expect(credentialShapedKeysDeep(spreadRequest.fields)).toEqual(["nonInteractiveToken"]);

    // Case 2: the accident NAME-based detection cannot catch — the refusal
    // quoting what it refused, under a member whose name is innocent. This is
    // exactly what the `token_class_refused` row forbids, and only the value
    // scan sees it.
    const quotedValue: JsonRpcErrorData = {
      type: "provideraccount.token_class_refused",
      fields: { provider: "claude", supplied: [`rejected: ${TOKEN_FIXTURE}`] },
    };
    expect(credentialShapedKeysDeep(quotedValue.fields)).toEqual([]);
    expect(
      stringValuesDeep(quotedValue.fields).some((value) => value.includes(TOKEN_FIXTURE)),
    ).toBe(true);

    // And the value scan does not fire on an envelope that merely mentions the
    // member name in prose, which is legitimate: naming the input is not
    // echoing it.
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
    // The one member this plane may never put in an envelope, checked against
    // the same marking the wire census uses rather than a second literal.
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

  it("settles a memory import as a count and a time, or as nothing to import", () => {
    expect(
      ProviderAccountMemoryImportResponseSchema.safeParse({
        outcome: "imported",
        count: 14,
        importedAt: TIMESTAMP,
      }).success,
    ).toBe(true);
    expect(
      ProviderAccountMemoryImportResponseSchema.safeParse({ outcome: "nothingToImport" }).success,
    ).toBe(true);
    // An import that copied nothing is `nothingToImport`, never `imported` with zero.
    expect(
      ProviderAccountMemoryImportResponseSchema.safeParse({
        outcome: "imported",
        count: 0,
        importedAt: TIMESTAMP,
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
