// What `Add a server` opens with: nothing, or what a registry result fills in. A draft holds names
// and how the server runs, never a value: a registry result carries none, and the values a person
// types are the form's alone.

import type {
  McpRegistryInput,
  McpRegistryServer,
  McpTransport,
} from "@ai-sidekicks/contracts/mcp/server";

/** How a server runs, in the form's `How it runs` choice. */
export type McpServerRunKind = "command" | "address";

/** A transport a server reached at an address is reached over. */
export type McpAddressTransport = Exclude<McpTransport, "stdio">;

/**
 * The fields `Add a server` opens with. `addressTransport` is the one a registry result names for
 * its address, absent where none is named; `environmentVariables` and `headers` are the names the
 * form asks a value for, each with what it is for and whether the server needs it.
 */
export interface ServerDraft {
  readonly name: string;
  readonly runKind: McpServerRunKind;
  readonly addressTransport?: McpAddressTransport;
  readonly command: string;
  /** One argument per line, in order. */
  readonly argumentLines: string;
  readonly address: string;
  readonly environmentVariables: readonly McpRegistryInput[];
  readonly headers: readonly McpRegistryInput[];
}

/** The draft `Add a server` opens with when nothing filled it in. */
export const EMPTY_SERVER_DRAFT: ServerDraft = {
  name: "",
  runKind: "command",
  command: "",
  argumentLines: "",
  address: "",
  environmentVariables: [],
  headers: [],
};

/**
 * The draft a registry result fills in: its title or name, then its first package's runtime and
 * arguments, or its first address where it runs as no package, and the names it reads.
 */
export function serverDraftOf(server: McpRegistryServer): ServerDraft {
  const name = server.title ?? server.name;
  const [registryPackage] = server.packages ?? [];
  if (registryPackage !== undefined) {
    const argumentWords = [
      ...(registryPackage.runtimeArguments ?? []).flatMap(argumentWordsOf),
      registryPackage.identifier,
      ...(registryPackage.packageArguments ?? []).flatMap(argumentWordsOf),
    ];
    return {
      ...EMPTY_SERVER_DRAFT,
      name,
      command: registryPackage.runtimeHint ?? "",
      argumentLines: argumentWords.join("\n"),
      environmentVariables: server.environmentVariables,
    };
  }
  const [remote] = server.remotes ?? [];
  if (remote !== undefined) {
    return {
      ...EMPTY_SERVER_DRAFT,
      name,
      runKind: "address",
      addressTransport: remote.type === "sse" ? "sse" : "http",
      address: remote.url,
      environmentVariables: server.environmentVariables,
      headers: remote.headers ?? [],
    };
  }
  return { ...EMPTY_SERVER_DRAFT, name, environmentVariables: server.environmentVariables };
}

/** How a registry result runs, as its row says it: as a package, at an address, or both. */
export function registryRunWords(server: McpRegistryServer): string {
  return [
    ...((server.packages ?? []).length > 0 ? ["Runs as a package"] : []),
    ...((server.remotes ?? []).length > 0 ? ["Reached at an address"] : []),
  ].join(" · ");
}

// The words one registry argument adds to the command line: a named one's name and value, a
// positional one's value. A value the registry leaves out, a secret's among them, is the person's
// to type, so a positional argument without one adds nothing.
function argumentWordsOf(argument: Readonly<Record<string, unknown>>): readonly string[] {
  const value =
    typeof argument["value"] === "string"
      ? argument["value"]
      : typeof argument["default"] === "string"
        ? argument["default"]
        : undefined;
  if (argument["type"] === "named" && typeof argument["name"] === "string") {
    return value === undefined ? [argument["name"]] : [argument["name"], value];
  }
  return value === undefined ? [] : [value];
}
