// The definition registry is written by the editor, the importer and the daemon's file watch,
// and read by the library, the composer and the workflow chooser. These cases hold the refusals
// every one of them relies on: one binding per provider, a project scope that names its project,
// a plugin agent that says so, a hue on the wheel, requests that carry only their own members,
// and the closed refusal reasons of resolution.
import { describe, expect, it } from "vitest";

import {
  AgentDefinitionCreateRequestSchema,
  AgentDefinitionExportRequestSchema,
  AgentDefinitionListEntrySchema,
  AgentDefinitionUpdateRequestSchema,
  AgentResolutionRefusedDetailsSchema,
} from "../definition.js";

const DEFINITION_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const CLAUDE_BINDING = {
  driverName: "claude",
  modelId: "opus",
  providerAccountId: null,
  effort: "high",
} as const;
const CODEX_BINDING = {
  driverName: "codex",
  modelId: "gpt-5.5",
  providerAccountId: null,
  effort: null,
} as const;

const FULL_CREATE_REQUEST = {
  name: "reviewer",
  description: "Reviews code changes.",
  icon: "magnifier",
  accentHue: "hue-07",
  bindings: { default: CLAUDE_BINDING, overrides: [CODEX_BINDING] },
  instructions: "Review the change.",
  goal: null,
  toolAllowlist: [],
  turnCap: 12,
  hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "lint" }] }] },
  memoryScope: "project",
  scope: "project",
  projectId: PROJECT_ID,
} as const;

const STORED_ENTRY = {
  definitionId: DEFINITION_ID,
  name: "reviewer",
  description: "",
  icon: null,
  accentHue: null,
  bindings: { default: CLAUDE_BINDING, overrides: [] },
  instructions: "",
  goal: null,
  toolAllowlist: null,
  turnCap: null,
  hooks: null,
  memoryScope: null,
  createdAt: "2026-09-29T10:00:00Z",
  updatedAt: "2026-09-29T10:00:00Z",
  origin: "ours",
  scope: "global",
  sourcePath: "/Users/person/.ai-sidekicks/agents/reviewer.md",
  orphaned: false,
  disabledInProvider: false,
  loadError: null,
} as const;

describe("agent.definitionCreate", () => {
  it("accepts the editor's whole save", () => {
    expect(AgentDefinitionCreateRequestSchema.safeParse(FULL_CREATE_REQUEST).success).toBe(true);
  });

  it("refuses an override that repeats the default's provider", () => {
    const request = {
      ...FULL_CREATE_REQUEST,
      bindings: { default: CLAUDE_BINDING, overrides: [{ ...CLAUDE_BINDING, modelId: "sonnet" }] },
    };
    expect(AgentDefinitionCreateRequestSchema.safeParse(request).success).toBe(false);
  });

  it("refuses two overrides for one provider", () => {
    const request = {
      ...FULL_CREATE_REQUEST,
      bindings: { default: CLAUDE_BINDING, overrides: [CODEX_BINDING, CODEX_BINDING] },
    };
    expect(AgentDefinitionCreateRequestSchema.safeParse(request).success).toBe(false);
  });

  it("refuses a project scope with no project, and a project on a global definition", () => {
    const { projectId: _projectId, ...withoutProject } = FULL_CREATE_REQUEST;
    expect(AgentDefinitionCreateRequestSchema.safeParse(withoutProject).success).toBe(false);
    expect(
      AgentDefinitionCreateRequestSchema.safeParse({ ...FULL_CREATE_REQUEST, scope: "global" })
        .success,
    ).toBe(false);
  });

  it("refuses a hue off the wheel", () => {
    expect(
      AgentDefinitionCreateRequestSchema.safeParse({ ...FULL_CREATE_REQUEST, accentHue: "hue-12" })
        .success,
    ).toBe(false);
  });

  it("refuses a member the request does not carry", () => {
    expect(
      AgentDefinitionCreateRequestSchema.safeParse({ ...FULL_CREATE_REQUEST, origin: "claude" })
        .success,
    ).toBe(false);
  });
});

describe("agent.definitionUpdate", () => {
  it("accepts a cleared member, bindings with no overrides, and a reattach path", () => {
    const request = {
      definitionId: DEFINITION_ID,
      bindings: { default: { ...CLAUDE_BINDING, effort: null } },
      hooks: null,
      reattachFilePath: "/Users/person/.claude/agents/reviewer.md",
    };
    expect(AgentDefinitionUpdateRequestSchema.safeParse(request).success).toBe(true);
  });

  it("refuses a scope, which only a create sets", () => {
    const request = { definitionId: DEFINITION_ID, scope: "project" };
    expect(AgentDefinitionUpdateRequestSchema.safeParse(request).success).toBe(false);
  });
});

describe("agent.definitionList entries", () => {
  it("names the plugin on a plugin's agent and on nothing else", () => {
    expect(
      AgentDefinitionListEntrySchema.safeParse({
        ...STORED_ENTRY,
        origin: "plugin",
        pluginName: "reviews",
      }).success,
    ).toBe(true);
    expect(
      AgentDefinitionListEntrySchema.safeParse({ ...STORED_ENTRY, origin: "plugin" }).success,
    ).toBe(false);
    expect(
      AgentDefinitionListEntrySchema.safeParse({ ...STORED_ENTRY, pluginName: "reviews" }).success,
    ).toBe(false);
  });
});

describe("agent.definitionExport", () => {
  it("refuses an export that names no definition", () => {
    const request = { definitionIds: [], folder: "/Users/person/agents" };
    expect(AgentDefinitionExportRequestSchema.safeParse(request).success).toBe(false);
  });
});

describe("the definition refusals", () => {
  it("carries a null model where the definition binds none for the driver", () => {
    const details = {
      definitionId: DEFINITION_ID,
      reason: "model_unavailable",
      driverName: "codex",
      modelId: null,
    };
    expect(AgentResolutionRefusedDetailsSchema.safeParse(details).success).toBe(true);
  });

  it("refuses a resolution refusal missing what its reason names", () => {
    const details = { definitionId: DEFINITION_ID, reason: "effort_unsupported", effort: "max" };
    expect(AgentResolutionRefusedDetailsSchema.safeParse(details).success).toBe(false);
  });
});
