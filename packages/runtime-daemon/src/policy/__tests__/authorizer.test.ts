// A decision is an allow only when a rule permits the request, no rule forbids it and nothing in
// the evaluation errored; a rules folder that will not load stops the start.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { UserId } from "@ai-sidekicks/contracts/session/id";

import { captureRejection } from "../../__fixtures__/capture-failure.js";
import { loadAuthorizer, type PolicyRequest } from "../authorizer.js";

const OWNER = "user-1" as UserId;

const SCHEMA = `
entity User;
entity Thing;
action "use", "inspect" appliesTo { principal: User, resource: Thing, context: { count: Long } };
`;

let rulesFolder: string;

beforeEach(async () => {
  rulesFolder = await mkdtemp(path.join(tmpdir(), "approval-rules-"));
});

afterEach(async () => {
  await rm(rulesFolder, { recursive: true, force: true });
});

async function writeRules(files: Readonly<Record<string, string>>): Promise<void> {
  for (const [fileName, text] of Object.entries(files)) {
    await writeFile(path.join(rulesFolder, fileName), text);
  }
}

function request(action: string, thing: string, count = 1): PolicyRequest {
  return { principal: OWNER, action, resource: { type: "Thing", id: thing }, context: { count } };
}

describe("loadAuthorizer", () => {
  it("allows only what a rule permits and none forbids, and denies an evaluation error", async () => {
    await writeRules({
      "schema.cedarschema": SCHEMA,
      "use.cedar": `permit (principal is User, action == Action::"use", resource);`,
      "forbid.cedar": `
        forbid (principal, action, resource) when { resource == Thing::"locked" };
        forbid (principal, action, resource) when { context.count + 9223372036854775807 < 0 };
      `,
    });
    const authorizer = await loadAuthorizer(rulesFolder);

    // The second forbid overflows, and so errors, for any positive count; at -1 it does not apply.
    expect(authorizer.decide(request("use", "open", -1))).toEqual({ decision: "allow" });
    expect(authorizer.decide(request("use", "locked", -1))).toEqual({
      decision: "deny",
      errors: [],
    });
    expect(authorizer.decide(request("inspect", "open", -1))).toEqual({
      decision: "deny",
      errors: [],
    });
    // Cedar skips the forbid whose evaluation overflowed and the permit still matches.
    expect(authorizer.decide(request("use", "open", 1))).toMatchObject({ decision: "deny" });
    // An action the schema does not hold is refused as a request, never allowed.
    expect(authorizer.decide(request("delete", "open", -1))).toMatchObject({ decision: "deny" });
  });

  it.each([
    ["a rule that does not parse", { "use.cedar": `permit (principal action, resource);` }],
    [
      "a rule that does not check against the schema",
      { "use.cedar": `permit (principal, action, resource) when { resource.owner == principal };` },
    ],
    ["a schema that does not parse", { "schema.cedarschema": "entity ;" }],
    ["no rules file", { "use.cedar": null }],
    ["no schema file", { "schema.cedarschema": null }],
  ] as const)("fails to load with %s", async (_case, overrides) => {
    const files: Record<string, string | null> = {
      "schema.cedarschema": SCHEMA,
      "use.cedar": `permit (principal is User, action == Action::"use", resource);`,
      ...overrides,
    };
    await writeRules(
      Object.fromEntries(
        Object.entries(files).filter((entry): entry is [string, string] => entry[1] !== null),
      ),
    );

    expect(await captureRejection(loadAuthorizer(rulesFolder))).toBeInstanceOf(Error);
  });
});
