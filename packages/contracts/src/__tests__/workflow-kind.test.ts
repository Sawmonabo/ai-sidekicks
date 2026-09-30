// The node catalog is served by the daemon and read by the palette, the inspector and
// an agent before it writes a workflow. These cases hold what the readers rely on: a
// parameter's type is from the closed list (with no channel), a collection nests, and a
// handle carries items or a capability and nothing else.
import { describe, expect, it } from "vitest";

import { WorkflowKindListResponseSchema } from "../workflow-kind.js";

const HTTP_KIND = {
  kind: "developer.http",
  version: 1,
  category: "developer",
  displayName: "HTTP request",
  description: "One request; the response splits into items.",
  icon: "globe",
  inputs: [{ id: "inputs/main/0", label: "Input", type: "main" }],
  outputs: [{ id: "outputs/main/0", label: "Response", type: "main" }],
  outputsDeriveFromParams: false,
  params: [
    { id: "url", label: "URL", type: "string", required: true },
    { id: "auth", label: "Credential", type: "secret", sensitive: true },
    {
      id: "headers",
      label: "Headers",
      type: "collection",
      multiple: true,
      fields: [
        { id: "name", label: "Name", type: "string" },
        { id: "value", label: "Value", type: "string", sensitive: true },
      ],
    },
  ],
  capabilities: { cancelable: true, resumable: false, sideEffects: "external" },
};

describe("WorkflowKindListResponseSchema", () => {
  it("accepts a kind with a sensitive credential and a nested collection", () => {
    expect(WorkflowKindListResponseSchema.safeParse({ kinds: [HTTP_KIND] }).success).toBe(true);
  });

  it("refuses the channel parameter type, also inside a collection", () => {
    const channelParam = { id: "where", label: "Channel", type: "channel" };
    expect(
      WorkflowKindListResponseSchema.safeParse({
        kinds: [{ ...HTTP_KIND, params: [channelParam] }],
      }).success,
    ).toBe(false);
    expect(
      WorkflowKindListResponseSchema.safeParse({
        kinds: [
          {
            ...HTTP_KIND,
            params: [{ id: "c", label: "C", type: "collection", fields: [channelParam] }],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("refuses a handle type other than main or tool", () => {
    expect(
      WorkflowKindListResponseSchema.safeParse({
        kinds: [{ ...HTTP_KIND, outputs: [{ id: "outputs/data/0", label: "Data", type: "data" }] }],
      }).success,
    ).toBe(false);
  });
});
