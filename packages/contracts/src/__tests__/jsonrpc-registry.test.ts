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
//   • Accepts: lowercase-rooted names with all-lowercase OR camelCase tails,
//     including the Tier-1 `session.*` surface, the doc's permitted
//     `settings.effectiveRead` / `driver.listCapabilities`, and the BL-142
//     per-plan camelCase-tail strings (Plan-009/010/012/016).
//   • Rejects: camelCase / uppercase ROOTS (roots stay lowercase — the
//     "didn't over-loosen" guard), bare camelCase (no dot), slash forms,
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
    // camelCase tails — the ratification (line 329) cites these as permitted.
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
  ];
  it.each(ACCEPTED)("accepts canonical method name `%s`", (name) => {
    expect(METHOD_NAME_FORMAT.test(name)).toBe(true);
  });

  const REJECTED = [
    // Roots stay lowercase — the "didn't over-loosen" guard.
    "Session.create", // uppercase root
    "textDocument.didOpen", // camelCase ROOT (LSP-style; rejected per line 329)
    "runtimeNode.capabilityUpdate", // camelCase root (the line-558 trap)
    // Structural rejections enumerated by the ratification (lines 333-335).
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
