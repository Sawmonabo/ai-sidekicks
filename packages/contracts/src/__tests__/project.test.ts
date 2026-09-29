// `project.ts`: the project list and the edits on a project's row.
import { describe, expect, it } from "vitest";

import { BRANCH_NAME_PATTERN_MAX_LEN } from "../machine-settings.js";
import {
  ProjectBranchPatternUpdateRequestSchema,
  ProjectEnvironmentUpdateRequestSchema,
  ProjectListSchema,
  ProjectRenameRequestSchema,
  ProjectSetupUpdateRequestSchema,
} from "../project.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const REPO_MOUNT_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f10";
const PROJECT_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f20";

const buildProjectSetup = () => ({
  filesToCopy: [".env.local"],
  commands: ["pnpm install"],
  timeLimitSeconds: 600,
});

const buildProject = () => ({
  projectId: PROJECT_ID,
  repoMountId: REPO_MOUNT_ID,
  name: "beacon",
  folderPath: "/Users/dev/code/beacon",
  state: "active",
  sessionCount: 3,
  runningSessionId: SESSION_ID,
  setup: buildProjectSetup(),
  environmentRows: [{ name: "HTTPS_PROXY", value: "http://proxy.local:3128" }],
  branchPattern: null,
  onOtherSideDisk: false,
});

describe("repo.projectList and the project edits", () => {
  it("accepts an active project, and a cloning one that has no mount yet", () => {
    const cloning = { ...buildProject(), repoMountId: null, state: "cloning", sessionCount: 1 };
    expect(ProjectListSchema.safeParse({ projects: [buildProject(), cloning] }).success).toBe(true);
    expect(
      ProjectListSchema.safeParse({ projects: [{ ...buildProject(), state: "deleted" }] }).success,
    ).toBe(false);
  });

  it("refuses a setup with no time limit to give up after", () => {
    const setup = { ...buildProjectSetup(), timeLimitSeconds: 0 };
    expect(
      ProjectSetupUpdateRequestSchema.safeParse({
        projectId: PROJECT_ID,
        setup: buildProjectSetup(),
      }).success,
    ).toBe(true);
    expect(
      ProjectSetupUpdateRequestSchema.safeParse({ projectId: PROJECT_ID, setup }).success,
    ).toBe(false);
  });

  it("renames to a name and refuses a blank one", () => {
    expect(
      ProjectRenameRequestSchema.safeParse({ projectId: PROJECT_ID, name: "Beacon" }).success,
    ).toBe(true);
    expect(
      ProjectRenameRequestSchema.safeParse({ projectId: PROJECT_ID, name: "  " }).success,
    ).toBe(false);
  });

  it("takes a branch pattern with {title} once and {session} at most once, or null", () => {
    const update = (pattern: string | null) =>
      ProjectBranchPatternUpdateRequestSchema.safeParse({ projectId: PROJECT_ID, pattern }).success;
    expect(update("sidekicks/{session}/{title}")).toBe(true);
    expect(update("sawmon/{title}")).toBe(true);
    expect(update(null)).toBe(true);
    expect(update("sawmon/fix")).toBe(false);
    expect(update("{title}/{title}")).toBe(false);
    expect(update("{session}/{session}/{title}")).toBe(false);
    expect(update(`{title}${"x".repeat(BRANCH_NAME_PATTERN_MAX_LEN)}`)).toBe(false);
    expect(update("sawmon/{title}\0")).toBe(false);
  });

  it("lists a project's own environment rows and replaces them whole", () => {
    const environmentUpdate = (environmentRows: unknown) =>
      ProjectEnvironmentUpdateRequestSchema.safeParse({ projectId: PROJECT_ID, environmentRows })
        .success;
    expect(environmentUpdate([{ name: "HTTPS_PROXY", value: "http://proxy.local:3128" }])).toBe(
      true,
    );
    expect(environmentUpdate([])).toBe(true);
    expect(ProjectEnvironmentUpdateRequestSchema.safeParse({ projectId: PROJECT_ID }).success).toBe(
      false,
    );
    expect(environmentUpdate([{ name: "HTTPS_PROXY", value: "a\0b" }])).toBe(false);
    expect(environmentUpdate([{ name: "", value: "x" }])).toBe(false);
    const { environmentRows: _environmentRows, ...withoutRows } = buildProject();
    expect(ProjectListSchema.safeParse({ projects: [withoutRows] }).success).toBe(false);
  });
});
