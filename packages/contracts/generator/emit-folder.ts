// Reads the folder the Rust contracts' emit step writes: per contract module its JSON Schema and a
// description of what the module exports, and the refusal codes once. The folder comes from
// another program, so every file is checked against its shape before the generator trusts it.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { Ajv2020, type SchemaObject, type ValidateFunction } from "ajv/dist/2020.js";

/** The scheme of every contract module schema's `$id`: `sidekicks-contracts:<module path>`. */
export const MODULE_ID_SCHEME = "sidekicks-contracts:";

/** A constant a TypeScript client reads as a value, written as `export const NAME = … as const`. */
export interface ContractConstant {
  readonly name: string;
  readonly doc: string;
  readonly value: unknown;
}

/** One method of a method table, its types named as a local definition or `<module>#<Name>`. */
export interface ContractMethod {
  readonly method: string;
  readonly procedureType: "query" | "mutation" | "subscription";
  readonly mutating: boolean;
  readonly params: string;
  readonly result: string;
  readonly emission?: string;
}

/**
 * A method table, written under its `*_METHOD_DESCRIPTORS` name. `typeName` names the table's
 * type where today's name is not the one derived from the table's name.
 */
export interface MethodTable {
  readonly name: string;
  readonly typeName?: string;
  readonly doc: string;
  readonly methods: readonly ContractMethod[];
}

/** One contract module: what the generator writes at `<output root>/<path>.ts`. */
export interface ContractModule {
  readonly path: string;
  readonly doc: string;
  readonly schema: SchemaObject;
  readonly checks: readonly string[];
  readonly constants: readonly ContractConstant[];
  readonly methodTables: readonly MethodTable[];
}

/** The refusal codes, written once as a string union into the module that owns them. */
export interface RefusalCodes {
  readonly module: string;
  readonly name: string;
  readonly doc: string;
  readonly codes: readonly string[];
}

/** Everything one emit run wrote. */
export interface ContractEmit {
  readonly modules: readonly ContractModule[];
  readonly refusalCodes: RefusalCodes;
}

const MODULE_PATH = "^[a-z0-9]+(?:-[a-z0-9]+)*(?:/[a-z0-9]+(?:-[a-z0-9]+)*)*$";
const DEFINITION_NAME = "^[A-Z][A-Za-z0-9]*$";
const TYPE_REFERENCE = `^(?:[a-z0-9]+(?:-[a-z0-9]+)*(?:/[a-z0-9]+(?:-[a-z0-9]+)*)*#)?[A-Z][A-Za-z0-9]*$`;
const DOC = { type: "string", minLength: 1 };
// The wire grammar: two to four lowerCamelCase segments joined by dots.
const WIRE_NAME = "^[a-z][A-Za-z0-9]*(?:\\.[a-z][A-Za-z0-9]*){1,3}$";

const MODULE_FILE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["doc", "checks", "constants", "methodTables"],
  properties: {
    doc: DOC,
    checks: {
      type: "array",
      uniqueItems: true,
      items: { type: "string", pattern: DEFINITION_NAME },
    },
    constants: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "doc", "value"],
        properties: {
          name: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]*$" },
          doc: DOC,
          value: true,
        },
      },
    },
    methodTables: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "doc", "methods"],
        properties: {
          name: { type: "string", pattern: "^[A-Z][A-Z0-9_]*_METHOD_DESCRIPTORS$" },
          typeName: { type: "string", pattern: DEFINITION_NAME },
          doc: DOC,
          methods: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["method", "procedureType", "mutating", "params", "result"],
              properties: {
                method: { type: "string", pattern: WIRE_NAME },
                procedureType: { enum: ["query", "mutation", "subscription"] },
                mutating: { type: "boolean" },
                params: { type: "string", pattern: TYPE_REFERENCE },
                result: { type: "string", pattern: TYPE_REFERENCE },
                emission: { type: "string", pattern: TYPE_REFERENCE },
              },
              if: { properties: { procedureType: { const: "subscription" } } },
              then: { required: ["emission"], properties: { emission: true } },
              else: { properties: { emission: false } },
            },
          },
        },
      },
    },
  },
};

const REFUSAL_CODES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["module", "name", "doc", "codes"],
  properties: {
    module: { type: "string", pattern: MODULE_PATH },
    name: { type: "string", pattern: DEFINITION_NAME },
    doc: DOC,
    codes: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { type: "string", pattern: WIRE_NAME },
    },
  },
};

const SCHEMA_FILE_SCHEMA = {
  type: "object",
  required: ["$schema", "$id", "$defs"],
  properties: {
    $schema: { const: "https://json-schema.org/draft/2020-12/schema" },
    $id: { type: "string" },
    $defs: { type: "object", propertyNames: { pattern: DEFINITION_NAME } },
  },
};

const emitAjv = new Ajv2020({ strict: true, allErrors: true });
const checkModuleFile = emitAjv.compile(MODULE_FILE_SCHEMA);
const checkRefusalCodes = emitAjv.compile(REFUSAL_CODES_SCHEMA);
const checkSchemaFile = emitAjv.compile(SCHEMA_FILE_SCHEMA);

/** Reads `file` as JSON and checks it with `check`; throws naming the file and every fault. */
function readChecked<T>(file: string, check: ValidateFunction): T {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!check(value)) {
    throw new Error(`${file} is not a valid emit file: ${emitAjv.errorsText(check.errors)}`);
  }
  return value as T;
}

/** Every folder under `root` holding a `schema.json`, as module paths. */
function findModulePaths(root: string, prefix = ""): string[] {
  const found: string[] = [];
  const folder = join(root, prefix);
  if (existsSync(join(folder, "schema.json"))) {
    found.push(prefix);
  }
  for (const entry of readdirSync(folder).sort()) {
    if (statSync(join(folder, entry)).isDirectory()) {
      found.push(...findModulePaths(root, prefix === "" ? entry : `${prefix}/${entry}`));
    }
  }
  return found;
}

/**
 * Reads and checks the whole emit folder. Throws on a file of the wrong shape, a schema whose
 * `$id` is not its module's, a module path outside the naming rule, or refusal codes owned by a
 * module the emit does not hold.
 */
export function readContractEmit(emitRoot: string): ContractEmit {
  const modulesRoot = join(emitRoot, "modules");
  const modules = findModulePaths(modulesRoot).map((path): ContractModule => {
    if (!new RegExp(MODULE_PATH).test(path)) {
      throw new Error(`module path ${JSON.stringify(path)} is not kebab-case folders`);
    }
    const schema = readChecked<SchemaObject>(
      join(modulesRoot, path, "schema.json"),
      checkSchemaFile,
    );
    if (schema["$id"] !== `${MODULE_ID_SCHEME}${path}`) {
      throw new Error(`${path}/schema.json has $id ${String(schema["$id"])}`);
    }
    const description = readChecked<Omit<ContractModule, "path" | "schema">>(
      join(modulesRoot, path, "module.json"),
      checkModuleFile,
    );
    return { path, schema, ...description };
  });
  const refusalCodes = readChecked<RefusalCodes>(
    join(emitRoot, "refusal-codes.json"),
    checkRefusalCodes,
  );
  if (!modules.some((module) => module.path === refusalCodes.module)) {
    throw new Error(`refusal codes name module ${refusalCodes.module}, which the emit lacks`);
  }
  return { modules, refusalCodes };
}
