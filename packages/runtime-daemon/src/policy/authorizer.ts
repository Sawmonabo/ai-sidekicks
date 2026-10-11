// The built-in approval rules over the app's own tools, parsed once and held resident in the Cedar
// engine, and every decision taken against them. A rules folder that is missing, holds no rules, or
// holds a file that does not parse or does not check against the schema stops the start; a decision
// whose evaluation errors is a deny, never an allow.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkParsePolicySet,
  preparsePolicySet,
  preparseSchema,
  statefulIsAuthorized,
  validate,
  type CedarValueJson,
  type DetailedError,
} from "@cedar-policy/cedar-wasm/nodejs";

import type { UserId } from "@ai-sidekicks/contracts/session/id";

import { mintUuidV7 } from "../uuid-v7.js";

// The rules the daemon ships, beside this module in the source and in the build.
const BUILT_IN_RULES_FOLDER = fileURLToPath(new URL("./rules/", import.meta.url));

// The schema's file in a rules folder; every other `.cedar` file there holds rules.
const SCHEMA_FILE_NAME = "schema.cedarschema";
const RULES_FILE_EXTENSION = ".cedar";

/**
 * One check against the rules: the action as the schema names it, on a resource named by its
 * entity type and id, for the machine's owning user. A request the schema does not admit is denied.
 */
export interface PolicyRequest {
  readonly principal: UserId;
  readonly action: string;
  readonly resource: { readonly type: string; readonly id: string };
  readonly context: Readonly<Record<string, CedarValueJson>>;
}

/**
 * What the rules decide. A deny carries the evaluation's errors, empty when no rule permits the
 * request or one forbids it.
 */
export type PolicyDecision =
  | { readonly decision: "allow" }
  | { readonly decision: "deny"; readonly errors: readonly string[] };

/**
 * A rules folder parsed and checked against its schema, held resident for every decision. The
 * engine keeps it in the loading thread's storage, so decisions are taken on the thread that loaded
 * it; each decision evaluates afresh, with nothing cached between them.
 */
export interface Authorizer {
  decide(request: PolicyRequest): PolicyDecision;
}

/**
 * Reads, parses and checks a rules folder, the built-in one unless another is named, and holds it
 * resident. Rejects when the folder is missing, holds no schema or no rules, or any file fails to
 * parse or to check against the schema.
 */
export async function loadAuthorizer(
  rulesFolder: string = BUILT_IN_RULES_FOLDER,
): Promise<Authorizer> {
  const schemaText = await readFile(path.join(rulesFolder, SCHEMA_FILE_NAME), "utf8");
  const ruleFileNames = (await readdir(rulesFolder))
    .filter((fileName) => fileName.endsWith(RULES_FILE_EXTENSION))
    .sort();
  if (ruleFileNames.length === 0) {
    throw new Error(`The rules folder ${rulesFolder} holds no ${RULES_FILE_EXTENSION} file.`);
  }
  const ruleTexts: string[] = [];
  for (const fileName of ruleFileNames) {
    const ruleText = await readFile(path.join(rulesFolder, fileName), "utf8");
    // Parsed one file at a time so a failure names its file.
    const parse = checkParsePolicySet({ staticPolicies: ruleText });
    if (parse.type === "failure") {
      throw rulesError(`${fileName} does not parse`, parse.errors);
    }
    ruleTexts.push(ruleText);
  }
  const policyText = ruleTexts.join("\n");

  const validation = validate({ schema: schemaText, policies: { staticPolicies: policyText } });
  if (validation.type === "failure") {
    throw rulesError(`${SCHEMA_FILE_NAME} does not parse`, validation.errors);
  }
  if (validation.validationErrors.length > 0) {
    throw rulesError(
      `the rules in ${rulesFolder} do not check against ${SCHEMA_FILE_NAME}`,
      validation.validationErrors.map((validationError) => validationError.error),
    );
  }

  // The engine's resident names are per thread and outlive this call, so each load takes its own.
  const residentName = mintUuidV7();
  const schemaParse = preparseSchema(residentName, schemaText);
  if (schemaParse.type === "failure") {
    throw rulesError(`${SCHEMA_FILE_NAME} does not parse`, schemaParse.errors);
  }
  const policyParse = preparsePolicySet(residentName, { staticPolicies: policyText });
  if (policyParse.type === "failure") {
    throw rulesError(`the rules in ${rulesFolder} do not parse`, policyParse.errors);
  }

  return {
    decide(request) {
      const answer = statefulIsAuthorized({
        principal: { type: "User", id: request.principal },
        action: { type: "Action", id: request.action },
        resource: request.resource,
        context: request.context,
        entities: [],
        preparsedSchemaName: residentName,
        preparsedPolicySetId: residentName,
        validateRequest: true,
      });
      if (answer.type === "failure") {
        return { decision: "deny", errors: answer.errors.map((error) => error.message) };
      }
      const { decision, diagnostics } = answer.response;
      // Cedar skips a rule whose evaluation errors and can still permit, so any error denies: a
      // forbid that failed to evaluate never lets the request through.
      if (diagnostics.errors.length > 0) {
        return {
          decision: "deny",
          errors: diagnostics.errors.map((error) => `${error.policyId}: ${error.error.message}`),
        };
      }
      return decision === "allow" ? { decision: "allow" } : { decision: "deny", errors: [] };
    },
  };
}

function rulesError(summary: string, errors: readonly DetailedError[]): Error {
  return new Error(
    `Approval rules: ${summary}: ${errors.map((error) => error.message).join("; ")}`,
  );
}
