// A node's params carry references and never a nested node or a tool's policy. The daemon's
// re-check at save and the inspector both read these refusals, so each one must name the
// parameter, and the member at fault.
import { describe, expect, it } from "vitest";

import type { WorkflowParamSpec } from "../../kind.js";
import { checkWorkflowNodeParams } from "../params.js";

const AGENT_ID = "0b7c8a7e-3f1d-4c2a-9a6e-5d4f3c2b1a09";

const SPECS: WorkflowParamSpec[] = [
  { id: "definition", label: "Sidekick", type: "agent" },
  { id: "tool", label: "Tool", type: "mcp-tool" },
  { id: "prompt", label: "Prompt", type: "text" },
  {
    id: "headers",
    label: "Headers",
    type: "collection",
    multiple: true,
    fields: [
      { id: "name", label: "Name", type: "string" },
      { id: "token", label: "Token", type: "secret", sensitive: true },
    ],
  },
];

const BINDING = {
  binding: { provider: "claude", scope: "project", scopeRef: "/repo", serverName: "github" },
  toolName: "search_issues",
};

const NESTED_NODE = {
  id: "inner",
  kind: "agent.run",
  kindVersion: 1,
  name: "Inner",
  order: 0,
  params: {},
};

describe("checkWorkflowNodeParams", () => {
  it("accepts references, and an expression where a parameter may hold one", () => {
    expect(
      checkWorkflowNodeParams(
        {
          definition: AGENT_ID,
          tool: BINDING,
          prompt: "={{ $json.summary }}",
          headers: [{ name: "Authorization", token: "secret://shared/github-read" }],
        },
        SPECS,
      ),
    ).toStrictEqual([]);
    expect(checkWorkflowNodeParams({ definition: "={{ $json.agentId }}" }, SPECS)).toStrictEqual(
      [],
    );
  });

  it("refuses a tool binding that carries a policy, naming the field", () => {
    const issues = checkWorkflowNodeParams({ tool: { ...BINDING, approvalMode: "never" } }, SPECS);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("tool");
    expect(issues[0]?.message).toContain("approvalMode");
  });

  it("refuses a nested node where a reference stands", () => {
    expect(checkWorkflowNodeParams({ definition: NESTED_NODE }, SPECS)).toEqual([
      expect.objectContaining({ path: "definition" }),
    ]);
    expect(checkWorkflowNodeParams({ tool: NESTED_NODE }, SPECS)).not.toStrictEqual([]);
  });

  it("refuses a secret outside the secret:// form, an expression included", () => {
    const headersHolding = (token: string) =>
      checkWorkflowNodeParams({ headers: [{ name: "Authorization", token }] }, SPECS);
    expect(headersHolding("ghp_inline-token-value")).toEqual([
      expect.objectContaining({ path: "headers.0.token" }),
    ]);
    expect(headersHolding("secret://session/github-read")).toHaveLength(1);
    expect(headersHolding("={{ $env.TOKEN }}")).toHaveLength(1);
  });
});
