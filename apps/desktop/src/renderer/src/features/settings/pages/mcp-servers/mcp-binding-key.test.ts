// How a binding is keyed, asserted as an identity and not a string shape: bindings that differ
// anywhere in the scope-qualified tuple key differently, and one binding keys the same way
// twice.

import { describe, expect, it } from "vitest";

import type { McpServerBindingRef } from "@ai-sidekicks/contracts/mcp";

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
  it("keys one binding the same way twice, and apart by scope, provider and root", () => {
    expect(mcpBindingKeyOf(USER_BINDING)).toBe(mcpBindingKeyOf({ ...USER_BINDING }));
    expect(mcpBindingKeyOf(USER_BINDING)).not.toBe(mcpBindingKeyOf(PROJECT_BINDING));
    expect(mcpBindingKeyOf(PROJECT_BINDING)).not.toBe(
      mcpBindingKeyOf({ ...PROJECT_BINDING, provider: "codex" }),
    );
    expect(mcpBindingKeyOf(PROJECT_BINDING)).not.toBe(
      mcpBindingKeyOf({ ...PROJECT_BINDING, scopeRef: "/work/other" }),
    );
  });

  // The `user` arm has no `scopeRef` and carries one segment fewer instead of a stand-in, so
  // the two arms differ by shape and not by the scope word alone.
  it("keys a user binding apart from a project binding rooted at the empty string", () => {
    expect(mcpBindingKeyOf(USER_BINDING)).not.toBe(
      mcpBindingKeyOf({ ...PROJECT_BINDING, scopeRef: "", serverName: USER_BINDING.serverName }),
    );
  });
});
