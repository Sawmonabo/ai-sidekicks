// The search of the public MCP Registry for servers to add: the request the person types and the
// page of results the daemon answers with, untrusted data that fills the add form and nothing else.
import { z } from "zod";

import { mcpHttpAddressSchema, mcpRequestText } from "./request-bounds.js";

/**
 * Searches the public MCP Registry for servers to add. The daemon makes the call,
 * only when the person types, and keeps nothing past the page it answers.
 */
export interface McpRegistrySearchRequest {
  query: string;
  cursor?: string | undefined;
}
/** Parses an {@link McpRegistrySearchRequest}. */
export const McpRegistrySearchRequestSchema: z.ZodType<
  McpRegistrySearchRequest,
  McpRegistrySearchRequest
> = z
  .object({
    query: mcpRequestText("McpRegistrySearchRequest.query"),
    cursor: mcpRequestText("McpRegistrySearchRequest.cursor").optional(),
  })
  .strict();

/** A registry server that runs as a package the person's machine installs. */
export interface McpRegistryPackage {
  registryType: string;
  identifier: string;
  runtimeHint?: string | undefined;
  runtimeArguments: string[];
}

/** A registry server reached at an address. */
export interface McpRegistryRemote {
  type: string;
  url: string;
}

/** An environment variable a registry server reads: its name, never a value. */
export interface McpRegistryEnvironmentVariable {
  name: string;
  description?: string | undefined;
  isRequired: boolean;
}

/**
 * One registry search result. Untrusted data from a public registry anyone can
 * publish to: it fills the add form and nothing else, and it never holds an
 * environment variable's value.
 */
export interface McpRegistryServer {
  name: string;
  title?: string | undefined;
  description: string;
  version: string;
  packages: McpRegistryPackage[];
  remotes: McpRegistryRemote[];
  environmentVariables: McpRegistryEnvironmentVariable[];
}

/** One page of registry search results. */
export interface McpRegistrySearchResponse {
  servers: McpRegistryServer[];
  nextCursor?: string | undefined;
}
/** Parses an {@link McpRegistrySearchResponse}. */
export const McpRegistrySearchResponseSchema: z.ZodType<McpRegistrySearchResponse> = z
  .object({
    servers: z.array(
      z
        .object({
          name: z.string().min(1),
          title: z.string().optional(),
          description: z.string(),
          version: z.string(),
          packages: z.array(
            z
              .object({
                registryType: z.string(),
                identifier: z.string().min(1),
                runtimeHint: z.string().optional(),
                runtimeArguments: z.array(z.string()),
              })
              .strict(),
          ),
          remotes: z.array(z.object({ type: z.string(), url: mcpHttpAddressSchema }).strict()),
          environmentVariables: z.array(
            z
              .object({
                name: z.string().min(1),
                description: z.string().optional(),
                isRequired: z.boolean(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    nextCursor: z.string().min(1).optional(),
  })
  .strict();
