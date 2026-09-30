// The skill list and the new-skill save hold two rules a reader relies on: a plugin's skill
// names its plugin and no other skill does, and a project skill names its project and no global
// skill does.
import { describe, expect, it } from "vitest";

import { SkillCreateRequestSchema, SkillListEntrySchema } from "../skill.js";

const SKILL_ID = "33333333-3333-4333-8333-333333333333";
const PROJECT_ID = "44444444-4444-4444-8444-444444444444";

const OURS_ENTRY = {
  skillId: SKILL_ID,
  name: "review-diff",
  description: "Reads a diff and says what is wrong with it.",
  icon: null,
  origin: "ours",
  scope: "global",
  folderPath: "/Users/person/.ai-sidekicks/skills/review-diff",
  files: [
    { path: "SKILL.md", size: 812, readable: true },
    { path: "scripts/check.sh", size: 120, readable: true },
    { path: "references/diagram.png", size: 48_000, readable: false },
  ],
  availability: { claude: true, codex: true },
  callForms: { claude: "/sidekicks:review-diff", codex: "$sidekicks:review-diff" },
  orphaned: false,
  disabledInProvider: ["codex"],
  loadError: null,
} as const;

describe("skill.list", () => {
  it("accepts a folder of ours available on both providers", () => {
    expect(SkillListEntrySchema.safeParse(OURS_ENTRY).success).toBe(true);
  });

  it("accepts a plugin's skill that names its plugin, and refuses one that does not", () => {
    const pluginEntry = {
      ...OURS_ENTRY,
      origin: "plugin",
      pluginName: "pr-review-toolkit",
      availability: { claude: true, codex: false },
      callForms: { claude: "/pr-review-toolkit:review-diff" },
    };
    expect(SkillListEntrySchema.safeParse(pluginEntry).success).toBe(true);
    const { pluginName: _pluginName, ...unnamed } = pluginEntry;
    expect(SkillListEntrySchema.safeParse(unnamed).success).toBe(false);
    expect(
      SkillListEntrySchema.safeParse({ ...OURS_ENTRY, pluginName: "pr-review-toolkit" }).success,
    ).toBe(false);
  });

  it("refuses a project skill with no project, and a project on a global skill", () => {
    expect(SkillListEntrySchema.safeParse({ ...OURS_ENTRY, scope: "project" }).success).toBe(false);
    expect(SkillListEntrySchema.safeParse({ ...OURS_ENTRY, projectId: PROJECT_ID }).success).toBe(
      false,
    );
  });
});

describe("skill.create", () => {
  const DESIGN_CREATE = {
    name: "Review Diff",
    description: "Reads a diff and says what is wrong with it.",
    body: "Read the diff.",
    icon: "bolt",
    files: [{ path: "references/style.md", content: "" }],
    scope: "project",
    projectId: PROJECT_ID,
  } as const;

  it("accepts the new-skill form's whole save", () => {
    expect(SkillCreateRequestSchema.safeParse(DESIGN_CREATE).success).toBe(true);
  });

  it("refuses a project scope with no project", () => {
    const { projectId: _projectId, ...withoutProject } = DESIGN_CREATE;
    expect(SkillCreateRequestSchema.safeParse(withoutProject).success).toBe(false);
  });
});
