// The definition registry is written by the editor, the importer and the daemon's file watch,
// and read by the library, the composer and the workflow chooser. These cases hold the refusals
// every one of them relies on: one binding per provider, a project scope that names its project,
// and a plugin agent that says so.
import { describe, expect, it } from "vitest";

import {
  AgentDefinitionCreateRequestSchema,
  AgentDefinitionListEntrySchema,
} from "../agent-definition.js";

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

const DESIGN_CREATE = {
  name: "reviewer",
  description: "Reads a diff and says what is wrong with it.",
  icon: "magnifier",
  accentHue: "teal",
  bindings: { default: CLAUDE_BINDING, overrides: [CODEX_BINDING] },
  executionPostureMode: "reviewed",
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
  executionPostureMode: null,
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
    expect(AgentDefinitionCreateRequestSchema.safeParse(DESIGN_CREATE).success).toBe(true);
  });

  it("refuses an override that repeats the default's provider", () => {
    const request = {
      ...DESIGN_CREATE,
      bindings: { default: CLAUDE_BINDING, overrides: [{ ...CLAUDE_BINDING, modelId: "sonnet" }] },
    };
    expect(AgentDefinitionCreateRequestSchema.safeParse(request).success).toBe(false);
  });

  it("refuses two overrides for one provider", () => {
    const request = {
      ...DESIGN_CREATE,
      bindings: { default: CLAUDE_BINDING, overrides: [CODEX_BINDING, CODEX_BINDING] },
    };
    expect(AgentDefinitionCreateRequestSchema.safeParse(request).success).toBe(false);
  });

  it("refuses a project scope with no project, and a project on a global definition", () => {
    const { projectId: _projectId, ...withoutProject } = DESIGN_CREATE;
    expect(AgentDefinitionCreateRequestSchema.safeParse(withoutProject).success).toBe(false);
    expect(
      AgentDefinitionCreateRequestSchema.safeParse({ ...DESIGN_CREATE, scope: "global" }).success,
    ).toBe(false);
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
