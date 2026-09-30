// The skill list is read by the Skills screen and the composer, and the folder
// verbs are written by the Skills screen and answered by the daemon. These cases
// hold what every one of them relies on: a plugin skill and a project skill that
// say so, a new skill's name and description that both providers will load, a
// file change that says what it does, and the closed refusal reasons of a path and
// an availability hold.
import { describe, expect, it } from "vitest";

import {
  SkillAvailabilityHeldDetailsSchema,
  SkillAvailabilityUpdateRequestSchema,
  SkillCreateRequestSchema,
  SkillFileReadRequestSchema,
  SkillListEntrySchema,
  SkillPathRefusedDetailsSchema,
  SkillRecordDiscardRequestSchema,
  SkillRecordReattachRequestSchema,
  SkillScanRequestSchema,
  SkillScanResponseSchema,
  SkillUpdateRequestSchema,
} from "../skill.js";

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

  it("refuses a name longer than Codex loads", () => {
    expect(
      SkillCreateRequestSchema.safeParse({ ...DESIGN_CREATE, name: "a".repeat(65) }).success,
    ).toBe(false);
  });

  it("refuses an empty description, which Codex will not load", () => {
    expect(
      SkillCreateRequestSchema.safeParse({ ...DESIGN_CREATE, description: "  " }).success,
    ).toBe(false);
  });

  it("refuses a project scope with no project", () => {
    const { projectId: _projectId, ...withoutProject } = DESIGN_CREATE;
    expect(SkillCreateRequestSchema.safeParse(withoutProject).success).toBe(false);
  });
});

describe("skill.update", () => {
  const DESIGN_UPDATE = {
    skillId: SKILL_ID,
    description: "Reads a diff and says what is wrong with it.",
    body: "Read the diff, then the tests.",
    files: [
      { path: "scripts/check.sh", content: "#!/bin/sh\n" },
      { path: "references/diagram-old.png", renamedFrom: "references/diagram.png" },
      { path: "references/tone.md", renamedFrom: "references/style.md", content: "Plain." },
    ],
    removedPaths: ["notes.txt"],
    icon: "book",
  } as const;

  it("accepts a whole-folder save with a write, a rename and a rename with a new body", () => {
    expect(SkillUpdateRequestSchema.safeParse(DESIGN_UPDATE).success).toBe(true);
  });

  it("refuses a file change that neither writes nor renames", () => {
    expect(
      SkillUpdateRequestSchema.safeParse({ ...DESIGN_UPDATE, files: [{ path: "notes.txt" }] })
        .success,
    ).toBe(false);
  });
});

describe("the other skill verbs", () => {
  it("accept the design's requests and the scan's findings", () => {
    expect(
      SkillFileReadRequestSchema.safeParse({ skillId: SKILL_ID, path: "SKILL.md" }).success,
    ).toBe(true);
    expect(
      SkillAvailabilityUpdateRequestSchema.safeParse({
        skillId: SKILL_ID,
        provider: "claude",
        available: true,
      }).success,
    ).toBe(true);
    expect(
      SkillScanRequestSchema.safeParse({ skillId: SKILL_ID, provider: "claude" }).success,
    ).toBe(true);
    expect(
      SkillScanResponseSchema.safeParse({
        findings: [{ path: "agents/openai.yaml", tools: ["Apply patch"], callSigil: true }],
      }).success,
    ).toBe(true);
    expect(
      SkillRecordReattachRequestSchema.safeParse({
        skillId: SKILL_ID,
        folderPath: "/Users/person/.claude/skills/review-diff",
      }).success,
    ).toBe(true);
    expect(SkillRecordDiscardRequestSchema.safeParse({ skillId: SKILL_ID }).success).toBe(true);
  });

  it("refuses a provider outside the two", () => {
    expect(
      SkillAvailabilityUpdateRequestSchema.safeParse({
        skillId: SKILL_ID,
        provider: "gemini",
        available: true,
      }).success,
    ).toBe(false);
  });
});

describe("skill refusals", () => {
  it("name a refused path with one of its three reasons", () => {
    expect(
      SkillPathRefusedDetailsSchema.safeParse({ path: "SKILL.md", reason: "names_entry_file" })
        .success,
    ).toBe(true);
    expect(
      SkillPathRefusedDetailsSchema.safeParse({ path: "../x", reason: "outside" }).success,
    ).toBe(false);
  });

  it("give an availability hold one of its two reasons", () => {
    expect(SkillAvailabilityHeldDetailsSchema.safeParse({ reason: "last_provider" }).success).toBe(
      true,
    );
    expect(SkillAvailabilityHeldDetailsSchema.safeParse({ reason: "plugin" }).success).toBe(false);
  });
});
