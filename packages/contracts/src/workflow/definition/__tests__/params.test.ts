// A node's params carry references and never a nested node or a tool's policy, and a secret
// reference stands only in a parameter its kind marks sensitive. The daemon's re-check at save and
// the inspector both read these refusals, so each one must name the parameter, and the member at
// fault.
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
      { id: "value", label: "Value", type: "string", sensitive: true },
    ],
  },
  { id: "body", label: "Body", type: "json" },
  { id: "credential", label: "Credential", type: "secret" },
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

  // A sensitive field is the only place a secret resolves, so a reference anywhere else would
  // reach the step as plain text; a sensitive field that is not a secret chooser, such as a
  // header value, also takes a plain literal.
  it("takes a secret reference only in a sensitive parameter, and whole", () => {
    const header = (value: string) =>
      checkWorkflowNodeParams({ headers: [{ name: "X-Token", value }] }, SPECS);
    expect(header("secret://project/github-read")).toStrictEqual([]);
    expect(header("plain-value")).toStrictEqual([]);
    expect(header("={{ $json.token }}")).toStrictEqual([]);
    expect(header("secret://session/github-read")).toEqual([
      expect.objectContaining({ path: "headers.0.value" }),
    ]);

    const outside = expect.stringContaining("sensitive");
    expect(checkWorkflowNodeParams({ prompt: "secret://shared/mail" }, SPECS)).toEqual([
      { path: "prompt", message: outside },
    ]);
    expect(checkWorkflowNodeParams({ body: { auth: ["secret://shared/mail"] } }, SPECS)).toEqual([
      { path: "body.auth.0", message: outside },
    ]);
    expect(checkWorkflowNodeParams({ credential: "secret://shared/mail" }, SPECS)).toEqual([
      { path: "credential", message: outside },
    ]);
  });

  it("refuses an expression that names a secret, in any parameter", () => {
    for (const params of [
      { prompt: '={{ "secret://shared/mail" }}' },
      { headers: [{ name: "X-Token", value: '={{ "secret://shared/mail" }}' }] },
    ]) {
      expect(checkWorkflowNodeParams(params, SPECS)).toEqual([
        expect.objectContaining({ message: expect.stringContaining("expression") }),
      ]);
    }
  });
});
