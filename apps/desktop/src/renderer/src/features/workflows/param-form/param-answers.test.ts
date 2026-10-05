// A form built from a kind's parameter list refuses an invalid answer, so a step waiting on a
// person never receives a value the kind did not declare.

import type { WorkflowParamSpec } from "@ai-sidekicks/contracts/workflow/kind";
import { describe, expect, it } from "vitest";
import { checkParamAnswers, seedParamAnswers } from "./param-answers.js";

const FIELDS: readonly WorkflowParamSpec[] = [
  { id: "summary", label: "Summary", type: "string", required: true },
  { id: "count", label: "Count", type: "number", default: 3 },
  {
    id: "tone",
    label: "Tone",
    type: "select",
    required: true,
    options: [
      { value: "plain", label: "Plain" },
      { value: 2, label: "Two" },
    ],
  },
  { id: "payload", label: "Payload", type: "json", default: { retry: true } },
  { id: "notes", label: "Notes", type: "text" },
  { id: "token", label: "Token", type: "secret", required: true, showWhen: { tone: [2] } },
  {
    id: "reviewers",
    label: "Reviewers",
    type: "collection",
    multiple: true,
    fields: [{ id: "name", label: "Name", type: "string", required: true }],
  },
];

describe("a form built from WorkflowParamSpec refuses an invalid answer", () => {
  it("refuses each invalid answer by its dotted path and skips a hidden field", () => {
    const answers = {
      ...seedParamAnswers(FIELDS),
      count: "abc",
      tone: "loud",
      payload: "{ retry: ",
      // Hidden while `tone` is not 2, so this empty secret is never checked.
      token: "",
      reviewers: [{ name: "" }],
    };

    expect(checkParamAnswers(FIELDS, answers)).toEqual({
      kind: "invalid",
      issues: {
        summary: "This field is required.",
        count: "Enter a number.",
        tone: "Choose one of the listed options.",
        payload: expect.stringMatching(/^This is not valid JSON: .*at position 2/u) as string,
        "reviewers.0.name": "This field is required.",
      },
    });
  });

  it("answers valid with parsed values and leaves empty optional fields out", () => {
    const answers = {
      ...seedParamAnswers(FIELDS, { summary: "Ship it" }),
      tone: 2,
      token: "s3cret",
      reviewers: [{ name: "Ada" }],
    };

    expect(checkParamAnswers(FIELDS, answers)).toEqual({
      kind: "valid",
      values: {
        summary: "Ship it",
        count: 3,
        tone: 2,
        payload: { retry: true },
        token: "s3cret",
        reviewers: [{ name: "Ada" }],
      },
    });
  });
});
