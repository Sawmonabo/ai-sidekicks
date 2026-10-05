// The relay rule at the trust boundary, checked against each verb's own contract: every member a
// verb takes a picked file in carries the token's path to the daemon, never a raw path the page
// named, and every path a reply offers to open comes back with a token the page can open it by.

import {
  AgentDefinitionExportRequestSchema,
  AgentDefinitionImportRequestSchema,
  AgentDefinitionUpdateRequestSchema,
} from "@ai-sidekicks/contracts/agent/definition";
import { SESSION_DRAFT_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/session/draft";
import {
  SessionHookListResponseSchema,
  SessionMemoryReadResponseSchema,
} from "@ai-sidekicks/contracts/session/inspector";
import { WORKFLOW_DEFINITION_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/workflow/definition/methods";
import type { ZodType } from "@ai-sidekicks/contracts/jsonrpc/registry";
import { describe, expect, it } from "vitest";

import { mintTokensForPaths, swapTokensForPaths } from "./file-path-relay.js";
import { FilePathRefs } from "./file-path-refs.js";
import { pageOwner } from "./file-path-refs.test-support.js";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const DEFINITION_ID = "00000000-0000-4000-8000-000000000002";
const PICKED_PATH = "/Users/person/Documents/brief.pdf";
const STAGING_IDS = [
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000004",
];

/** A path-taking verb, its request schema, and its params with `file` in each file member. */
interface PathTakingVerb {
  readonly method: string;
  readonly requestSchema: ZodType;
  readonly params: (file: string) => unknown;
}

const PATH_TAKING_VERBS: readonly PathTakingVerb[] = [
  {
    method: "session.attachmentAdd",
    requestSchema: SESSION_DRAFT_METHOD_DESCRIPTORS["session.attachmentAdd"].requestSchema,
    params: (file) => ({
      sessionId: SESSION_ID,
      items: [
        { kind: "file", clientStagingId: STAGING_IDS[0], path: file },
        {
          kind: "mcpResource",
          clientStagingId: STAGING_IDS[1],
          serverName: "docs",
          uri: "docs://a",
        },
      ],
    }),
  },
  {
    method: "workflow.definitionExport",
    requestSchema:
      WORKFLOW_DEFINITION_METHOD_DESCRIPTORS["workflow.definitionExport"].requestSchema,
    params: (file) => ({ definitionId: "release-notes", filePath: file }),
  },
  {
    method: "workflow.definitionImport",
    requestSchema:
      WORKFLOW_DEFINITION_METHOD_DESCRIPTORS["workflow.definitionImport"].requestSchema,
    params: (file) => ({ filePath: file, scope: "shared" }),
  },
  {
    method: "agent.definitionExport",
    requestSchema: AgentDefinitionExportRequestSchema,
    params: (file) => ({ definitionIds: [DEFINITION_ID], folder: file }),
  },
  {
    method: "agent.definitionImport",
    requestSchema: AgentDefinitionImportRequestSchema,
    params: (file) => ({ folder: file }),
  },
  {
    method: "agent.definitionUpdate",
    requestSchema: AgentDefinitionUpdateRequestSchema,
    params: (file) => ({ definitionId: DEFINITION_ID, reattachFilePath: file }),
  },
];

describe("a verb that acts on a picked file", () => {
  it.each(PATH_TAKING_VERBS)(
    "$method goes to the daemon with the token's path, and refuses a raw path",
    ({ method, requestSchema, params }) => {
      const refs = new FilePathRefs();
      const page = pageOwner(1);
      const token = refs.mint(page, PICKED_PATH);

      const sent = swapTokensForPaths(refs, page, method, params(token));

      // What the daemon receives is the contract's own request, with the path in the token's place.
      expect(requestSchema.parse(sent)).toEqual(params(PICKED_PATH));
      expect(() => swapTokensForPaths(refs, page, method, params(PICKED_PATH))).toThrow(TypeError);
      // A token another page was handed opens nothing here either.
      const otherPage = pageOwner(2);
      expect(() => swapTokensForPaths(refs, otherPage, method, params(token))).toThrow(TypeError);
    },
  );

  it("leaves an optional file member the page left out for the contract to judge", () => {
    const refs = new FilePathRefs();
    const params = { definitionId: DEFINITION_ID, name: "Reviewer" };

    expect(swapTokensForPaths(refs, pageOwner(1), "agent.definitionUpdate", params)).toEqual(
      params,
    );
  });
});

describe("a reply that offers a path to open", () => {
  it("comes back with a token for each path, which opens that path for that page", () => {
    const refs = new FilePathRefs();
    const page = pageOwner(1);
    const memoryFile = "/Users/person/.claude/projects/app/CLAUDE.md";
    const memoryFolder = "/Users/person/.claude/projects/app/memory";
    const memory = SessionMemoryReadResponseSchema.parse({
      sessionId: SESSION_ID,
      home: "/Users/person/.claude",
      autoMemory: { enabled: true },
      entries: [
        { path: memoryFile, kind: "file" },
        { path: memoryFolder, kind: "folder" },
      ],
    });
    const hookSource = "/Users/person/app/.codex/hooks.toml";
    const hooks = SessionHookListResponseSchema.parse({
      sessionId: SESSION_ID,
      provider: "codex",
      kind: "loadedHooks",
      folders: [
        {
          folder: "/Users/person/app",
          hooks: [
            {
              key: "pre-tool",
              event: "PreToolUse",
              handlerType: "command",
              timeoutSeconds: 30,
              sourcePath: hookSource,
              source: "project",
              enabled: true,
              managed: false,
              hash: "sha256:00",
              trustStatus: "trusted",
            },
          ],
          errors: [],
          warnings: [],
        },
      ],
    });
    const hookFile = "/Users/person/app/.claude/settings.json";
    const hookFiles = SessionHookListResponseSchema.parse({
      sessionId: SESSION_ID,
      provider: "claude",
      kind: "hookFiles",
      files: [{ path: hookFile }],
    });

    const opened = (method: string, value: unknown): Record<string, string> =>
      Object.fromEntries(
        Object.entries(mintTokensForPaths(refs, page, method, value)).map(([path, token]) => [
          path,
          refs.requirePath(page, token),
        ]),
      );

    expect(opened("session.memoryRead", memory)).toEqual({
      [memoryFile]: memoryFile,
      [memoryFolder]: memoryFolder,
    });
    expect(opened("session.hookList", hooks)).toEqual({ [hookSource]: hookSource });
    expect(opened("session.hookList", hookFiles)).toEqual({ [hookFile]: hookFile });
  });
});
