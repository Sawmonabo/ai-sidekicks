// Writes a module's TypeScript types from its schema with json-schema-to-typescript. A member
// carrying `tsType` (a brand, `Uint8Array` for bytes, the type of an Ajv `$data` value) becomes
// that type as written, and a reference into another module becomes an imported type.
import type { SchemaObject } from "ajv/dist/2020.js";
import { compile, type JSONSchema } from "json-schema-to-typescript";

import { MODULE_ID_SCHEME } from "./emit-folder.ts";
import type { ModuleImports } from "./module-imports.ts";

const ROOT_NAME = "GeneratedModuleRoot";

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

/** A copy of `node` ready for the type generator: titles gone, `tsType` and foreign refs typed. */
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
  if (typeof reference === "string" && reference.startsWith(MODULE_ID_SCHEME)) {
    const match = /^sidekicks-contracts:([^#]+)#\/\$defs\/([A-Za-z0-9]+)$/u.exec(reference);
    if (match === null) {
      throw new Error(`reference ${reference} does not name another module's definition`);
    }
    imports.addFromModule(match[1]!, match[2]!, "type");
    return { tsType: match[2]!, ...described };
  }
  return Object.fromEntries(
    Object.entries(schema)
      // A title would make the generator name the type after it instead of its definition.
      .filter(([key]) => key !== "title")
      .map(([key, value]) => [key, prepareForTypes(value, imports)]),
  );
}

/**
 * Generates one exported type per definition of `schema`, named as its `$defs` key; throws when
 * the generator names one differently, since its check is named from that key.
 */
export async function generateTypes(schema: SchemaObject, imports: ModuleImports): Promise<string> {
  const definitions = prepareForTypes(schema["$defs"], imports) as Record<string, JSONSchema>;
  const names = Object.keys(definitions);
  if (names.length === 0) {
    return "";
  }
  // A root that references every definition, so each is written as its own named type.
  const root: JSONSchema = {
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(names.map((name) => [name, { $ref: `#/$defs/${name}` }])),
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
