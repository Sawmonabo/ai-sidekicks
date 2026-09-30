// `METHOD_NAME_FORMAT` is the single source of the JSON-RPC method-name format; the daemon's
// method registry imports it. This pins it in the package that owns it: every segment starts
// lowercase and may hold camelCase, and uppercase-leading segments, bare camelCase, slash
// forms, underscores and malformed dots are refused. LSP `$/` system methods match the
// daemon-local `METHOD_NAME_LSP_REGEX` instead and must not match this one.
import { describe, expect, it } from "vitest";

import { METHOD_NAME_FORMAT } from "../jsonrpc-registry.js";

describe("METHOD_NAME_FORMAT — canonical JSON-RPC method-name format", () => {
  const ACCEPTED = [
    // All-lowercase segments.
    "session.create",
    "session.read",
    "session.subscribe",
    "presence.subscribe",
    // Three-segment nested form (`noun.sub.verb`).
    "run.stream.notify",
    // camelCase tails.
    "settings.effectiveRead",
    "driver.listCapabilities",
    "repo.mountRead",
    "repo.executionModeSelect",
    "approval.requestCreate",
    "orchestration.runCreate",
    "orchestration.childRunLinkRead",
    "orchestration.budgetRead",
    "orchestration.budgetUpdate",
    "agent.configUpdate",
    // camelCase roots; `providerAccount.*` is the only such namespace.
    "providerAccount.list",
    "providerAccount.resetCredentialHome",
    // The dotted-camelCase style the LSP itself uses.
    "textDocument.didOpen",
  ];
  it.each(ACCEPTED)("accepts canonical method name `%s`", (name) => {
    expect(METHOD_NAME_FORMAT.test(name)).toBe(true);
  });

  const REJECTED = [
    // No segment may start uppercase, in the root or any tail; uppercase is allowed only inside
    // a segment.
    "Session.create", // uppercase-starting root
    "ProviderAccount.list", // uppercase-starting root of the widened namespace
    "session.Create", // uppercase-starting tail
    // Structural rejections.
    "sessionCreate", // no namespace dot
    "session/create", // slash separator (HTTP-path conflation)
    "SessionCreate", // PascalCase (type-name collision)
    // Underscores are the durable-event form, not a method.
    "repo_mount.attach",
    "approval.rule_revoked",
    // Malformed dots.
    "session.", // trailing dot
    ".create", // leading dot
    "session..create", // empty segment
    // LSP `$/` system methods are daemon-local, not this format.
    "$/subscription/notify",
    "$/cancelRequest",
  ];
  it.each(REJECTED)("rejects non-canonical method name `%s`", (name) => {
    expect(METHOD_NAME_FORMAT.test(name)).toBe(false);
  });

  it("is stateless across calls (no `g` flag — shared instance is reuse-safe)", () => {
    // A `g` flag would advance `lastIndex` between `.test()` calls and alternate results on
    // repeated input; the shared instance must be stateless.
    expect(METHOD_NAME_FORMAT.global).toBe(false);
    expect(METHOD_NAME_FORMAT.test("session.create")).toBe(true);
    expect(METHOD_NAME_FORMAT.test("session.create")).toBe(true);
  });
});
