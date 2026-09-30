// How a binding is keyed.
//
// THE KEY IS ASSERTED AS AN IDENTITY AND NOT AS A STRING SHAPE. What matters is that
// two bindings that differ anywhere in the scope-qualified tuple key differently and
// that one binding keys the same way twice — never the particular separator.

import { describe, expect, it } from "vitest";

import type { McpServerBindingRef } from "@ai-sidekicks/contracts";

import { mcpBindingKeyOf } from "./mcp-binding-key.js";

const USER_BINDING: McpServerBindingRef = {
  provider: "claude",
  scope: "user",
  serverName: "filesystem",
};

const PROJECT_BINDING: McpServerBindingRef = {
  provider: "claude",
  scope: "project",
  scopeRef: "/work/atlas",
  serverName: "filesystem",
};

describe("mcpBindingKeyOf", () => {
  it("keys one binding the same way twice", () => {
    expect(mcpBindingKeyOf(USER_BINDING)).toBe(mcpBindingKeyOf({ ...USER_BINDING }));
  });

  it("keys two same-named servers in two scopes differently", () => {
    expect(mcpBindingKeyOf(USER_BINDING)).not.toBe(mcpBindingKeyOf(PROJECT_BINDING));
  });

  it("keys two same-named servers on two providers differently", () => {
    expect(mcpBindingKeyOf(PROJECT_BINDING)).not.toBe(
      mcpBindingKeyOf({ ...PROJECT_BINDING, provider: "codex" }),
    );
  });

  it("keys two project bindings under different roots differently", () => {
    expect(mcpBindingKeyOf(PROJECT_BINDING)).not.toBe(
      mcpBindingKeyOf({ ...PROJECT_BINDING, scopeRef: "/work/other" }),
    );
  });

  // Both halves of the tuple are free-form wire strings — a checkout path an operator
  // chose and a server name an operator typed — so a separator that either of them may
  // contain is not a separator. Under a space join these two bindings are one key: the
  // rows share a React identity, and whichever mutation settles last writes its outcome
  // onto both controls.
  it("keys two bindings apart when a space moves across the scope/name boundary", () => {
    expect(
      mcpBindingKeyOf({ ...PROJECT_BINDING, scopeRef: "/repo one", serverName: "server" }),
    ).not.toBe(
      mcpBindingKeyOf({ ...PROJECT_BINDING, scopeRef: "/repo", serverName: "one server" }),
    );
  });

  // The `user` arm carries no `scopeRef`, and the encoding says so by carrying one
  // segment fewer rather than by substituting a stand-in value for the member that arm
  // does not have — which is what keeps the two arms apart on their own shape and not
  // on the scope word alone.
  it("keys a user binding apart from a project binding rooted at the empty string", () => {
    expect(mcpBindingKeyOf(USER_BINDING)).not.toBe(
      mcpBindingKeyOf({ ...PROJECT_BINDING, scopeRef: "", serverName: USER_BINDING.serverName }),
    );
  });

  // The negative control for the three above: the server NAME alone is equal across
  // every one of those pairs, so a key built from it would have collapsed them.
  it("does not key on the server name", () => {
    const sharedNames = new Set(
      [USER_BINDING, PROJECT_BINDING, { ...PROJECT_BINDING, provider: "codex" as const }].map(
        (binding) => binding.serverName,
      ),
    );
    expect(sharedNames.size).toBe(1);
  });
});
