// BL-142 — `METHOD_NAME_FORMAT` canonical-format pin.
//
// `METHOD_NAME_FORMAT` (packages/contracts/src/jsonrpc-registry.ts) is the
// single runtime source for the JSON-RPC method-name format ratified at
// docs/architecture/contracts/api-payload-contracts.md §JSON-RPC Method-Name
// Registry (Tier 1 Ratified). The daemon's `MethodRegistry.register()` check
// imports it (no per-package re-declaration). This test is the anti-drift pin
// in the package that OWNS the constant: it asserts the exact accept/reject
// vectors the ratification enumerates, so any future edit that loosens the
// root or drops the camelCase tail (the BL-142 regression) fails here — at the
// source — independent of the daemon's integration tests.
//
// Coverage shape:
//   • Accepts: names whose every segment starts lowercase, with all-lowercase
//     OR camelCase segments — the Tier-1 `session.*` surface, the doc's
//     permitted `settings.effectiveRead` / `driver.listCapabilities`, the
//     BL-142 per-plan camelCase-tail strings (Plan-009/010/012/016), and
//     since the 2026-09-05 root widening the camelCase-ROOTED
//     `providerAccount.*` verbs plus the LSP-shaped `textDocument.didOpen`.
//   • Rejects: uppercase-STARTING segments in any position (the "didn't
//     over-loosen" guard — the widening admits an uppercase letter inside a
//     segment, never at its start), bare camelCase (no dot), slash forms,
//     PascalCase, underscores (the Spec-006 event form), and malformed dots.
//   • Excludes: LSP `$/`-prefixed system methods — those match the daemon-
//     local `METHOD_NAME_LSP_REGEX`, NOT this canonical format (asserted as a
//     non-match here so the two shapes stay distinct).
import { describe, expect, it } from "vitest";

import { METHOD_NAME_FORMAT } from "../jsonrpc-registry.js";

describe("METHOD_NAME_FORMAT — canonical JSON-RPC method-name format (BL-142)", () => {
  const ACCEPTED = [
    // Tier-1 `session.*` surface (all-lowercase segments).
    "session.create",
    "session.read",
    "session.join",
    "session.subscribe",
    "presence.subscribe",
    // Three-segment nested form (`noun.sub.verb`).
    "run.stream.notify",
    // camelCase tails — the registry ratification cites these as permitted.
    "settings.effectiveRead",
    "driver.listCapabilities",
    // BL-142 per-plan camelCase-tail strings (Plan-009/010/012/016 Phase 3).
    "repo.mountRead",
    "repo.executionModeSelect",
    "approval.requestCreate",
    "channel.rosterRead",
    "orchestration.runCreate",
    "orchestration.childRunLinkRead",
    "orchestration.budgetRead",
    "orchestration.budgetUpdate",
    "agent.configUpdate",
    // camelCase ROOTS — admitted by the 2026-09-05 first-segment widening.
    // `providerAccount.*` is the corpus's only camelCase-rooted namespace
    // (Spec-029 / Plan-029 / ADR-028); the daemon's `register()` guard threw
    // on all ten of its verbs under the prior root class.
    "providerAccount.list",
    "providerAccount.resetCredentialHome",
    // The LSP precedent the ratification cites for the dotted-camelCase style
    // roots its own names this way; the widening stops rejecting it.
    "textDocument.didOpen",
  ];
  it.each(ACCEPTED)("accepts canonical method name `%s`", (name) => {
    expect(METHOD_NAME_FORMAT.test(name)).toBe(true);
  });

  const REJECTED = [
    // No segment may START uppercase — the "didn't over-loosen" guard the root
    // widening had to preserve. An uppercase letter is admitted INSIDE a
    // segment and never at its head, in the root as in every tail.
    "Session.create", // uppercase-starting root
    "ProviderAccount.list", // uppercase-starting root of the widened namespace
    "session.Create", // uppercase-starting tail
    // Structural rejections enumerated by the ratification.
    "sessionCreate", // no namespace dot
    "session/create", // slash separator (HTTP-path conflation)
    "SessionCreate", // PascalCase (type-name collision)
    // Underscores are the Spec-006 durable-event form — invalid as a method.
    "runtime_node.attach",
    "approval.rule_revoked",
    // Malformed dots.
    "session.", // trailing dot
    ".create", // leading dot
    "session..create", // empty segment
    // LSP `$/`-prefixed system methods are daemon-local, NOT this format.
    "$/subscription/notify",
    "$/cancelRequest",
  ];
  it.each(REJECTED)("rejects non-canonical method name `%s`", (name) => {
    expect(METHOD_NAME_FORMAT.test(name)).toBe(false);
  });

  it("is stateless across calls (no `g` flag — shared instance is reuse-safe)", () => {
    // A `g`-flagged regex would advance `lastIndex` between `.test()` calls and
    // return alternating results on a repeated input. The shared cross-package
    // instance MUST be stateless.
    expect(METHOD_NAME_FORMAT.global).toBe(false);
    expect(METHOD_NAME_FORMAT.test("session.create")).toBe(true);
    expect(METHOD_NAME_FORMAT.test("session.create")).toBe(true);
  });
});
