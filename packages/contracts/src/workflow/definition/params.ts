// A node's reference parameters and its secret references, checked against the parameter list
// of the node's kind. A reference names a record kept elsewhere, so a parameter never carries a
// nested node or a tool's policy, and a `secret://` reference stands only in a parameter the kind
// marks sensitive, never inside an expression.
import { z } from "zod";

import { AgentDefinitionIdSchema } from "../../agent/definition.js";
import { ProjectIdSchema } from "../../project.js";
import { SessionIdSchema } from "../../session/id.js";
import type { WorkflowParamSpec, WorkflowParamType } from "../kind.js";
import { WorkflowSecretReferenceSchema } from "../secret.js";
import { WorkflowToolBindingSchema } from "./document.js";

const EXPRESSION_FORM = /^=\{\{[\s\S]*\}\}$/u;
const SECRET_SCHEME = "secret://";

// No expression resolves a secret, so a secret parameter holds the reference alone; the other
// reference types also take an expression, as every parameter does.
const REFERENCE_PARAM_SCHEMAS: Partial<Record<WorkflowParamType, z.ZodType>> = {
  secret: WorkflowSecretReferenceSchema,
  agent: AgentDefinitionIdSchema,
  project: ProjectIdSchema,
  session: SessionIdSchema,
  "mcp-tool": WorkflowToolBindingSchema,
};

/**
 * One parameter value the check refused. `path` is the value's dotted place, its parameter's id
 * first (`headers.0.token` inside a repeating collection), and `message` names the fault, such as
 * a tool binding's `approvalMode`.
 */
export interface WorkflowParamIssue {
  path: string;
  message: string;
}

/**
 * Checks one node's parameters against its kind's parameter list, walking into collections, and
 * returns every value refused: a reference that is not one (a secret outside the `secret://`
 * form, an id that is not one, a tool binding carrying a nested node or a policy), a `secret://`
 * value in a parameter the kind does not mark sensitive, and an expression naming `secret://`.
 * A parameter left out and an id the kind does not list are not checked here.
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
    // A secret parameter's own schema below refuses a malformed reference and an expression, so
    // only the sensitive rule is checked for it here.
    if (spec.type !== "secret") {
      checkSecretText(value, spec.sensitive === true, place, issues);
    } else if (
      spec.sensitive !== true &&
      typeof value === "string" &&
      value.startsWith(SECRET_SCHEME)
    ) {
      issues.push(outsideSensitiveIssue(place));
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

// Walks every string a leaf value holds. A `secret://` value outside a sensitive parameter is
// refused; inside one it must be a whole reference, and no expression may name one.
function checkSecretText(
  value: unknown,
  isSensitive: boolean,
  place: string,
  issues: WorkflowParamIssue[],
): void {
  if (typeof value === "string") {
    if (isExpression(value)) {
      if (value.includes(SECRET_SCHEME)) {
        issues.push({ path: place, message: "No expression resolves a secret." });
      }
    } else if (value.startsWith(SECRET_SCHEME)) {
      if (!isSensitive) {
        issues.push(outsideSensitiveIssue(place));
      } else {
        const parsed = WorkflowSecretReferenceSchema.safeParse(value);
        for (const issue of parsed.error?.issues ?? []) {
          issues.push({ path: place, message: issue.message });
        }
      }
    }
  } else if (Array.isArray(value)) {
    value.forEach((entry: unknown, index) => {
      checkSecretText(entry, isSensitive, `${place}.${String(index)}`, issues);
    });
  } else if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      checkSecretText(entry, isSensitive, `${place}.${key}`, issues);
    }
  }
}

function outsideSensitiveIssue(place: string): WorkflowParamIssue {
  return {
    path: place,
    message: "A secret:// reference stands only in a parameter its kind marks sensitive.",
  };
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
