// A workflow secret's name and reference are read by the chooser, the daemon's check at save and
// the step that resolves it; its value crosses the wire once, inward. These cases hold the name
// rule, the reference form, and a value that no reply carries.
import { describe, expect, it } from "vitest";

import {
  WorkflowSecretSummarySchema,
  WorkflowSecretNotFoundDetailsSchema,
  composeWorkflowSecretReference,
  isWorkflowSecretName,
  parseWorkflowSecretReference,
} from "../workflow-secret.js";

const SECRET_ID = "44444444-4444-4444-8444-444444444444";

describe("isWorkflowSecretName", () => {
  it("accepts lowercase letters, digits and hyphens starting with a letter or digit", () => {
    expect(isWorkflowSecretName("github-read")).toBe(true);
    expect(isWorkflowSecretName("0-token")).toBe(true);
    expect(isWorkflowSecretName("a".repeat(64))).toBe(true);
  });

  it("refuses a leading hyphen, capitals, other characters, an empty name and 65 characters", () => {
    for (const name of ["-read", "GitHub", "git_hub", "git hub", "", "a".repeat(65)]) {
      expect(isWorkflowSecretName(name), name).toBe(false);
    }
  });
});

describe("the secret:// reference", () => {
  it("reads back what it writes", () => {
    const reference = { scope: "project", name: "github-read" } as const;
    expect(composeWorkflowSecretReference(reference)).toBe("secret://project/github-read");
    expect(parseWorkflowSecretReference("secret://project/github-read")).toEqual(reference);
    expect(parseWorkflowSecretReference("secret://shared/mail")).toEqual({
      scope: "shared",
      name: "mail",
    });
  });

  it("reads nothing from a session scope, a bad name, a second segment or another scheme", () => {
    for (const text of [
      "secret://session/github-read",
      "secret://project/GitHub",
      "secret://project/github/read",
      "secret://project/",
      "secrets://project/github-read",
      "secret://project/github-read/",
    ]) {
      expect(parseWorkflowSecretReference(text), text).toBeNull();
    }
  });

  it("carries only a reference on a missing secret", () => {
    expect(
      WorkflowSecretNotFoundDetailsSchema.safeParse({ reference: "secret://project/github-read" })
        .success,
    ).toBe(true);
    expect(
      WorkflowSecretNotFoundDetailsSchema.safeParse({ reference: "github-read" }).success,
    ).toBe(false);
  });
});

describe("workflow.secretCreate", () => {
  it("answers with the record and refuses a reply that carries the value", () => {
    const record = { secretId: SECRET_ID, scope: "shared", name: "mail" };
    expect(WorkflowSecretSummarySchema.safeParse(record).success).toBe(true);
    expect(
      WorkflowSecretSummarySchema.safeParse({ ...record, secretValue: "hunter2" }).success,
    ).toBe(false);
  });
});
