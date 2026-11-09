// Writes a module's TypeScript types from its schema with json-schema-to-typescript. A member
// carrying `tsType` (a brand, `Uint8Array` for bytes, the type of an Ajv `$data` value) becomes
// that type as written, and a reference names its definition's type: imported from another module,
// declared once in this one.
import type { SchemaObject } from "ajv/dist/2020.js";
import { compile, type JSONSchema } from "json-schema-to-typescript";

import { MODULE_ID_SCHEME } from "./emit-folder.ts";
import type { ModuleImports } from "./module-imports.ts";

const ROOT_NAME = "GeneratedModuleRoot";
/** How a schema refers to a definition of its own module. */
const LOCAL_DEFINITION = "#/$defs/";

/** Whether `schema` is an object that may hold no member at all. */
function isEmptyClosedObject(schema: Record<string, unknown>): boolean {
  const properties = schema["properties"];
  return (
    schema["type"] === "object" &&
    schema["additionalProperties"] === false &&
    (properties === undefined || Object.keys(properties as object).length === 0) &&
    !["oneOf", "anyOf", "allOf", "if", "patternProperties", "$ref"].some((key) => key in schema)
  );
}

/** Whether `arm` is only an `if`/`then`/`else` rule, which states no shape of its own. */
function isConditionalRule(arm: unknown): boolean {
  return (
    arm !== null &&
    typeof arm === "object" &&
    Object.keys(arm).every((key) => key === "if" || key === "then" || key === "else")
  );
}

/** Whether every arm of `arms` only restricts `schema`'s own shape, naming no member it lacks. */
function isRuleOnShape(schema: Record<string, unknown>, arms: unknown[]): boolean {
  const members = new Set(Object.keys((schema["properties"] ?? {}) as object));
  return (
    "type" in schema &&
    arms.every((arm) =>
      Object.keys(((arm as Record<string, unknown>)["properties"] ?? {}) as object).every(
        (member) => members.has(member),
      ),
    )
  );
}

/**
 * `schema` without the arms that only restrict it: an `allOf` of conditional rules and an `anyOf`
 * over its own shape. The generator would write each as a second, numbered type; the check holds
 * them, and a type has no way to say them.
 */
function withoutRuleArms(schema: Record<string, unknown>): Record<string, unknown> {
  const { allOf, anyOf, ...rest } = schema;
  return {
    ...rest,
    ...(Array.isArray(allOf) && allOf.every(isConditionalRule) ? {} : { allOf }),
    ...(Array.isArray(anyOf) && isRuleOnShape(schema, anyOf) ? {} : { anyOf }),
  };
}

/** Keywords whose value maps a name the wire chose (a member, a definition) to its schema. */
const SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  "$defs",
  "properties",
  "patternProperties",
]);
/** Keywords whose value lists the arms of a union. */
const UNION_KEYWORDS: ReadonlySet<string> = new Set(["anyOf", "oneOf"]);

/** Each schema of `map` ready for the type generator, under its name as written. */
function prepareSchemaMap(map: Record<string, unknown>, imports: ModuleImports): unknown {
  return Object.fromEntries(
    Object.entries(map).map(([name, schema]) => [name, prepareForTypes(schema, imports)]),
  );
}

/** Whether `arm` is typed `never`, which adds nothing to a union. */
function isNeverArm(arm: unknown): boolean {
  return (arm as Record<string, unknown>)["tsType"] === "never";
}

/**
 * The arms of a union ready for the type generator, less those typed `never`: written as they
 * are, `never | null` would read `never` beside a member that is only ever `null`.
 */
function prepareUnionArms(arms: unknown[], imports: ModuleImports): unknown[] {
  const prepared = arms.map((arm) => prepareForTypes(arm, imports));
  const kept = prepared.filter((arm) => !isNeverArm(arm));
  return kept.length === 0 ? prepared : kept;
}

/** A schema keyword's value ready for the type generator. */
function prepareKeyword(keyword: string, value: unknown, imports: ModuleImports): unknown {
  if (SCHEMA_MAP_KEYWORDS.has(keyword)) {
    return prepareSchemaMap(value as Record<string, unknown>, imports);
  }
  if (UNION_KEYWORDS.has(keyword) && Array.isArray(value)) {
    return prepareUnionArms(value, imports);
  }
  return prepareForTypes(value, imports);
}

/** A copy of `node` ready for the type generator: titles gone, `tsType` and references typed. */
function prepareForTypes(node: unknown, imports: ModuleImports): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => prepareForTypes(item, imports));
  }
  if (node === null || typeof node !== "object") {
    return node;
  }
  const schema = node as Record<string, unknown>;
  const description = typeof schema["description"] === "string" ? schema["description"] : undefined;
  const described = description === undefined ? {} : { description };
  if (typeof schema["tsType"] === "string") {
    return { tsType: schema["tsType"], ...described };
  }
  if (isEmptyClosedObject(schema)) {
    // The generator would write `{}`, which TypeScript reads as any value but null.
    return { tsType: "Record<string, never>", ...described };
  }
  const reference = schema["$ref"];
  if (typeof reference === "string" && reference.startsWith(LOCAL_DEFINITION)) {
    // A described reference would otherwise be written as a second, numbered copy of its type.
    return { tsType: reference.slice(LOCAL_DEFINITION.length), ...described };
  }
  if (typeof reference === "string" && reference.startsWith(MODULE_ID_SCHEME)) {
    const match = /^sidekicks-contracts:([^#]+)#\/\$defs\/([A-Za-z0-9]+)$/u.exec(reference);
    if (match === null) {
      throw new Error(`reference ${reference} does not name another module's definition`);
    }
    imports.addFromModule(match[1]!, match[2]!, "type");
    return { tsType: match[2]!, ...described };
  }
  return Object.fromEntries(
    Object.entries(withoutRuleArms(schema))
      .filter(([, value]) => value !== undefined)
      // A title would make the generator name the type after it instead of its definition.
      .filter(([key]) => key !== "title")
      .map(([key, value]) => [key, prepareKeyword(key, value, imports)]),
  );
}

/**
 * Generates one exported type per definition of `schema`, named as its `$defs` key; throws when
 * the generator names one differently, since its check is named from that key.
 */
export async function generateTypes(schema: SchemaObject, imports: ModuleImports): Promise<string> {
  const definitions = prepareSchemaMap(
    schema["$defs"] as Record<string, unknown>,
    imports,
  ) as Record<string, JSONSchema>;
  const names = Object.keys(definitions);
  if (names.length === 0) {
    return "";
  }
  // A root that references every definition, so each is written as its own named type.
  const root: JSONSchema = {
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(
      names.map((name) => [name, { $ref: `${LOCAL_DEFINITION}${name}` }]),
    ),
    $defs: definitions,
  };
  const code = await compile(root, ROOT_NAME, {
    bannerComment: "",
    format: false,
    // An object schema without `additionalProperties` is closed: the closing pass leaves an
    // object open only where it writes `additionalProperties: true` (a kept-unknown type).
    additionalProperties: false,
    strictIndexSignatures: true,
  });
  const rootStart = code.indexOf(`export interface ${ROOT_NAME} {`);
  const rootEnd = code.indexOf("\n}", rootStart);
  if (rootStart === -1 || rootEnd === -1) {
    throw new Error("json-schema-to-typescript wrote no module root");
  }
  const types = code.slice(0, rootStart) + code.slice(rootEnd + 2);
  for (const name of names) {
    if (!new RegExp(`^export (?:interface|type) ${name}\\b`, "mu").test(types)) {
      throw new Error(`json-schema-to-typescript did not write definition ${name} under its name`);
    }
  }
  return types.trim();
}
