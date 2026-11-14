// Where a server applies, in the words the page draws for each scope. The wire's scope value never
// reaches the screen.

import type {
  McpServerInventoryEntry,
  McpWritableBindingRef,
} from "@ai-sidekicks/contracts/mcp/server";

/** A scope a person writes a server at, in the order `Where it applies` offers them. */
export type McpWritableScope = McpWritableBindingRef["scope"];

/**
 * The words for each scope but a plugin's, which names its plugin instead: the add form's three
 * for the scopes a person writes, and the provider's own word, as the wire sends it, for a
 * connector's and an administrator's.
 */
export const MCP_SCOPE_WORDS: Readonly<
  Record<Exclude<McpServerInventoryEntry["scope"], "plugin">, string>
> = {
  user: "All projects",
  project: "This project · in the repo",
  local: "This project · not in the repo",
  connector: "connector",
  managed: "managed",
};

/** The scopes a person writes a server at, in the order `Where it applies` offers them. */
export const WRITABLE_MCP_SCOPES: readonly McpWritableScope[] = ["user", "project", "local"];
