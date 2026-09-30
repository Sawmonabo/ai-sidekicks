// How a binding is keyed, asserted as an identity and not a string shape: bindings that differ
// anywhere in the scope-qualified tuple key differently, and one binding keys the same way
// twice.

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

  // Both tuple halves are free-form wire strings (an operator's checkout path and server name),
  // so a separator either may contain is not a separator. Under a space join these two bindings
  // are one key: the rows share a React identity and the last mutation to settle writes its
  // outcome onto both controls.
  it("keys two bindings apart when a space moves across the scope/name boundary", () => {
    expect(
      mcpBindingKeyOf({ ...PROJECT_BINDING, scopeRef: "/repo one", serverName: "server" }),
    ).not.toBe(
      mcpBindingKeyOf({ ...PROJECT_BINDING, scopeRef: "/repo", serverName: "one server" }),
    );
  });

  // The `user` arm has no `scopeRef` and carries one segment fewer instead of a stand-in, so
  // the two arms differ by shape and not by the scope word alone.
  it("keys a user binding apart from a project binding rooted at the empty string", () => {
    expect(mcpBindingKeyOf(USER_BINDING)).not.toBe(
      mcpBindingKeyOf({ ...PROJECT_BINDING, scopeRef: "", serverName: USER_BINDING.serverName }),
    );
  });

  // Negative control for the three above: the server name is equal across every pair, so a key
  // built from it would have collapsed them.
  it("does not key on the server name", () => {
    const sharedNames = new Set(
      [USER_BINDING, PROJECT_BINDING, { ...PROJECT_BINDING, provider: "codex" as const }].map(
        (binding) => binding.serverName,
      ),
    );
    expect(sharedNames.size).toBe(1);
  });
});
