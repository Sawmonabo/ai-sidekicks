// A node's reference parameters: the value an agent, project, session, secret or MCP tool
// parameter holds, checked against the parameter list of the node's kind. A reference names a
// record kept elsewhere, so a parameter never carries a nested node or a tool's policy.
import { z } from "zod";

import { AgentDefinitionIdSchema } from "../../agent/definition.js";
import { ProjectIdSchema } from "../../project.js";
import { SessionIdSchema } from "../../session/id.js";
import type { WorkflowParamSpec, WorkflowParamType } from "../kind.js";
import { parseWorkflowSecretReference } from "../secret.js";
import { WorkflowToolBindingSchema } from "./document.js";

const EXPRESSION_FORM = /^=\{\{[\s\S]*\}\}$/u;

// No expression resolves a secret, so a secret parameter holds the reference alone; the other
// reference types also take an expression, as every parameter does.
const REFERENCE_PARAM_SCHEMAS: Partial<Record<WorkflowParamType, z.ZodType>> = {
  secret: z.string().refine((text) => parseWorkflowSecretReference(text) !== null, {
    message: "A secret is written secret://shared/<name> or secret://project/<name>.",
  }),
  agent: AgentDefinitionIdSchema,
  project: ProjectIdSchema,
  session: SessionIdSchema,
  "mcp-tool": WorkflowToolBindingSchema,
};

/**
 * One reference parameter whose value the check refused. `path` is the parameter's dotted
 * place, its id first (`headers.0.token` inside a repeating collection), and `message` names
 * the member at fault, such as a tool binding's `approvalMode`.
 */
export interface WorkflowParamIssue {
  path: string;
  message: string;
}

/**
 * Checks the reference parameters of one node against its kind's parameter list, walking into
 * collections, and returns every value refused: a secret outside the `secret://` form, an id
 * that is not one, or a tool binding with a member beyond its server and tool name, such as a
 * nested node or a policy. A parameter left out, an id the kind does not list, and the other
 * parameter types are not checked here.

 */
export function checkWorkflowNodeParams(
  params: Readonly<Record<string, unknown>>,
  specs: readonly WorkflowParamSpec[],
): WorkflowParamIssue[] {
  const issues: WorkflowParamIssue[] = [];
  checkFieldList(params, specs, "", issues);
  return issues;
}

function checkFieldList(
  values: Readonly<Record<string, unknown>>,
  specs: readonly WorkflowParamSpec[],
  pathPrefix: string,
  issues: WorkflowParamIssue[],
): void {
  for (const spec of specs) {
    if (!Object.hasOwn(values, spec.id)) {
      continue;
    }
    const value = values[spec.id];
    const place = `${pathPrefix}${spec.id}`;
    if (spec.type === "collection") {
      checkCollection(spec, value, place, issues);
      continue;
    }
    const schema = REFERENCE_PARAM_SCHEMAS[spec.type];
    if (schema === undefined || (spec.type !== "secret" && isExpression(value))) {
      continue;
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        issues.push({
          path: [place, ...issue.path.map(String)].join("."),
          message: issue.message,
        });
      }
    }
  }
}

// A repeating collection holds a list of records and a single one a record; any other value
// holds no reference to check.
function checkCollection(
  spec: Extract<WorkflowParamSpec, { type: "collection" }>,
  value: unknown,
  place: string,
  issues: WorkflowParamIssue[],
): void {
  if (spec.multiple === true) {
    if (Array.isArray(value)) {
      value.forEach((entry: unknown, index) => {
        if (isRecord(entry)) {
          checkFieldList(entry, spec.fields, `${place}.${String(index)}.`, issues);
        }
      });
    }
  } else if (isRecord(value)) {
    checkFieldList(value, spec.fields, `${place}.`, issues);
  }
}

function isExpression(value: unknown): boolean {
  return typeof value === "string" && EXPRESSION_FORM.test(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
