// Writes a module's checks: Ajv 2020 compiles each checked definition to standalone code at
// generation time, so the shipped checks hold no `eval` and compile nothing at run time. Ajv's
// ES-module output still loads its run-time helpers with `require` and leaves its functions
// untyped; this rewrites both, statement by statement, into TypeScript the package can ship.
import { Ajv2020, _, type KeywordCxt, type SchemaObject } from "ajv/dist/2020.js";
import standaloneCode from "ajv/dist/standalone/index.js";

import { MODULE_ID_SCHEME, type ContractModule } from "./emit-folder.ts";
import type { ModuleImports } from "./module-imports.ts";

/** The hand-written module the generated checks import their type, formats and helpers from. */
export const SCHEMA_CHECK_MODULE = "schema-check";

/** The generated check's name for definition `name`. */
export function checkName(name: string): string {
  return `validate${name}`;
}

/** Every `format` value the schemas name, so Ajv's strict mode knows each one at compile time. */
function formatNames(schemas: readonly SchemaObject[]): Set<string> {
  const names = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node !== null && typeof node === "object") {
      const format = (node as { format?: unknown }).format;
      if (typeof format === "string") {
        names.add(format);
      }
      Object.values(node).forEach(walk);
    }
  };
  schemas.forEach(walk);
  return names;
}

/**
 * The code of `minBytes` or `maxBytes`: a `{"$bytes": n}` member's attachment, read from the
 * check's context, is within the bound. Without the context, or with no such attachment, it fails.
 */
function byteBoundCode(comparison: ">=" | "<=") {
  return (cxt: KeywordCxt): void => {
    const { data, schema } = cxt;
    const attachment = _`this.attachments[${data}.$bytes]`;
    cxt.fail(
      _`!(${data} && typeof ${data} == "object" && Number.isInteger(${data}.$bytes) && this && Array.isArray(this.attachments) && ${attachment} instanceof Uint8Array && ${attachment}.byteLength ${comparison === ">=" ? _`>=` : _`<=`} ${schema})`,
    );
  };
}

/** A strict Ajv holding every module's schema, so a reference across modules resolves. */
function createAjv(schemas: readonly SchemaObject[]): Ajv2020 {
  const formats = Object.fromEntries(
    [...formatNames(schemas)].map((name) => [name, (): boolean => true]),
  );
  const ajv = new Ajv2020({
    strict: true,
    $data: true,
    // The contracts name a tagged union's tag as its `discriminator`, so a check picks the arm by it.
    discriminator: true,
    allErrors: true,
    messages: false,
    passContext: true,
    // Generation only needs each format's name: the code calls `SCHEMA_FORMATS[name]`.
    formats,
    code: { source: true, esm: true, lines: false, optimize: true, formats: _`SCHEMA_FORMATS` },
  });
  ajv.addKeyword({ keyword: "tsType", schemaType: "string" });
  ajv.addKeyword({ keyword: "minBytes", schemaType: "number", code: byteBoundCode(">=") });
  ajv.addKeyword({ keyword: "maxBytes", schemaType: "number", code: byteBoundCode("<=") });
  for (const schema of schemas) {
    ajv.addSchema(schema);
  }
  return ajv;
}

/** Splits Ajv's one-line output into its top-level statements. */
function splitStatements(code: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | undefined;
  for (let index = 0; index < code.length; index++) {
    const character = code[index];
    if (quote !== undefined) {
      if (character === "\\") {
        index++;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "`") {
      throw new Error(
        "Ajv's output holds a template literal, which the statement split cannot read",
      );
    } else if (character === "{" || character === "(" || character === "[") {
      depth++;
    } else if (character === "}" || character === ")" || character === "]") {
      depth--;
    }
    const isStatementEnd =
      depth === 0 &&
      (character === ";" || (character === "}" && code.startsWith("function ", start)));
    if (isStatementEnd) {
      statements.push(code.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (code.slice(start).trim() !== "" || quote !== undefined || depth !== 0) {
    throw new Error("Ajv's output did not split into whole statements");
  }
  return statements;
}

/** Applies `replace` to the parts of `code` outside string literals. */
function replaceOutsideStrings(code: string, replace: (part: string) => string): string {
  return code
    .split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/u)
    .map((part, index) => (index % 2 === 1 ? part : replace(part)))
    .join("");
}

const AJV_FUNCTION_HEAD =
  /^function (validate\d+)\(data, \{instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors=\{\}\}=\{\}\)\{/u;
const AJV_RUNTIME = /^const (func\d+) = require\("ajv\/dist\/runtime\/([a-z0-9_]+)"\)\.default;$/u;
/** The Ajv run-time helpers the checks call, by Ajv's file name, as `schema-check` exports them. */
const RUNTIME_HELPERS: Readonly<Record<string, string>> = {
  ucs2length: "ucs2length",
  equal: "deepEqual",
};
const AJV_EXPORT = /^export const (\w+) = (validate\d+);$/u;

/**
 * Generates the checks for `module`'s checked definitions, with every module's schema available
 * for references. Adds the imports the code needs to `imports` and returns the module's code.
 */
export function generateChecks(
  module: ContractModule,
  checkedNames: readonly string[],
  allSchemas: readonly SchemaObject[],
  imports: ModuleImports,
): string {
  if (checkedNames.length === 0) {
    return "";
  }
  const ajv = createAjv(allSchemas);
  const exportsByName = Object.fromEntries(
    checkedNames.map((name) => [
      checkName(name),
      `${MODULE_ID_SCHEME}${module.path}#/$defs/${name}`,
    ]),
  );
  const statements = splitStatements(standaloneCode.default(ajv, exportsByName));

  const typeByFunction = new Map<string, string>();
  const kept: string[] = [];
  for (const statement of statements) {
    const exported = AJV_EXPORT.exec(statement);
    if (exported !== null) {
      typeByFunction.set(exported[2]!, exported[1]!.slice("validate".length));
    } else if (statement !== '"use strict";') {
      kept.push(statement);
    }
  }

  // A schema object Ajv embeds but no statement reads is dropped.
  const used = kept.filter((statement) => {
    const constant = /^const (schema\d+) = /u.exec(statement);
    return (
      constant === null ||
      kept.some(
        (other) => other !== statement && new RegExp(`\\b${constant[1]!}\\b`, "u").test(other),
      )
    );
  });

  // Ajv's code is plain JavaScript: its locals and helpers are typed `any` so it compiles under
  // the package's strict settings, and each exported check's function answers a type predicate.
  const rewritten = used.flatMap((statement): string[] => {
    const runtime = AJV_RUNTIME.exec(statement);
    if (runtime !== null) {
      const helper = RUNTIME_HELPERS[runtime[2]!];
      if (helper === undefined) {
        throw new Error(`${module.path}: Ajv calls its helper ${runtime[2]!}, which has no import`);
      }
      imports.addFromHandWrittenModule(SCHEMA_CHECK_MODULE, helper, "value");
      return [`const ${runtime[1]!} = ${helper};`];
    }
    if (statement.includes("require(")) {
      throw new Error(
        `${module.path}: Ajv loads a module the generator does not map: ${statement}`,
      );
    }
    const schemaConstant = /^const (schema\d+) = /u.exec(statement);
    if (schemaConstant !== null) {
      return [`const ${schemaConstant[1]!}: any = ${statement.slice(schemaConstant[0].length)}`];
    }
    const head = AJV_FUNCTION_HEAD.exec(statement);
    if (head === null) {
      return [statement];
    }
    const functionName = head[1]!;
    const checkedType = typeByFunction.get(functionName);
    const typedHead =
      `function ${functionName}(this: any, data: any, ` +
      `{instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {})` +
      `: ${checkedType === undefined ? "boolean" : `data is ${checkedType}`} {`;
    const body = replaceOutsideStrings(statement.slice(head[0].length), (part) =>
      part
        .replace(/\b(let|var|const) (\w+) = /gu, "$1 $2: any = ")
        .replace(/\b(let|var) (\w+);/gu, "$1 $2: any;"),
    );
    // Declares `errors` where TypeScript sees a function's own properties, beside `evaluated`.
    return [typedHead + body, `${functionName}.errors = null;`];
  });

  if (used.some((statement) => statement.includes("SCHEMA_FORMATS"))) {
    imports.addFromHandWrittenModule(SCHEMA_CHECK_MODULE, "SCHEMA_FORMATS", "value");
  }
  imports.addFromHandWrittenModule(SCHEMA_CHECK_MODULE, "SchemaCheck", "type");

  const checks = [...typeByFunction.entries()]
    .sort(([, left], [, right]) => (left < right ? -1 : 1))
    .map(
      ([functionName, typeName]) =>
        `/** Checks that a value is a {@link ${typeName}}. */\n` +
        `export const ${checkName(typeName)}: SchemaCheck<${typeName}> = ${functionName};`,
    );
  return [...rewritten.map((statement) => `// prettier-ignore\n${statement}`), ...checks].join(
    "\n",
  );
}
