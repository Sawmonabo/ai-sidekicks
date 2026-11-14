// Writes a module's checks: Ajv 2020 compiles each checked definition to standalone code at
// generation time, so the shipped checks hold no `eval` and compile nothing at run time. Every
// definition compiles to one function, written once in its owner's checks file and imported
// wherever another check calls it. Ajv's ES-module output still loads its run-time helpers with
// `require` and leaves its functions untyped; this rewrites both, statement by statement, into
// TypeScript the package can ship.
import { Ajv2020, Name, _, type Code, type KeywordCxt, type SchemaObject } from "ajv/dist/2020.js";
import standaloneCode from "ajv/dist/standalone/index.js";

import { MODULE_ID_SCHEME, type ContractModule } from "./emit-folder.ts";
import type { ModuleImports } from "./module-imports.ts";

/** The hand-written module the generated checks import their type, formats and helpers from. */
const SCHEMA_CHECK_MODULE = "schema-check";

/** The `schema-check` export a `maxJsonBytes` check calls to measure its value. */
const WIRE_BYTE_LENGTH = "wireByteLength";

/** The `schema-check` export a `uniqueItemKey` check calls to find a repeated key. */
const REPEATS_ITEM_KEY = "repeatsItemKey";

/** The `schema-check` values the generated code may name, imported where a check names one. */
const RUN_TIME_VALUES = ["SCHEMA_FORMATS", WIRE_BYTE_LENGTH, REPEATS_ITEM_KEY] as const;

/**
 * The folder, under the generated one, of every module's checks file. A module's checks sit apart
 * from its types and constants, so a bundle that reads only a module's constants loads none of
 * its checks, and one that loads a check on first use carries it in that load alone.
 */
export const CHECKS_FOLDER = "checks";

/** The path, under the generated folder, of `modulePath`'s checks file. */
export function checksModulePath(modulePath: string): string {
  return `${CHECKS_FOLDER}/${modulePath}`;
}

/** The generated check's name for definition `name`. */
export function checkName(name: string): string {
  return `validate${name}`;
}

/** The key one definition is compiled under: its reference from any module. */
function definitionKey(modulePath: string, name: string): string {
  return `${MODULE_ID_SCHEME}${modulePath}#/$defs/${name}`;
}

/** The definitions of `module`'s schema, by name. */
function definitionsOf(module: ContractModule): Record<string, SchemaObject> {
  return (module.schema["$defs"] ?? {}) as Record<string, SchemaObject>;
}

/** A definition a compiled function checks: its owning module and its name. */
interface CompiledDefinition {
  readonly module: string;
  readonly name: string;
}

/**
 * A generation run's one compile of every check: the strict Ajv holding each definition as a
 * schema of its own, so every reference to it, from any module, calls one compiled function.
 */
export interface CheckCompiler {
  readonly ajv: Ajv2020;
  /** The definition each compiled function checks, by Ajv's name for the function. */
  readonly definitionOf: ReadonlyMap<string, CompiledDefinition>;
}

/** A format named for an integer type (`uint32`, `int64`) checks numbers; every other, strings. */
const NUMBER_FORMAT_NAME = /^u?int[0-9]+$/u;

/** Every `format` value the schemas name, so Ajv's strict mode knows each one at compile time. */
function formatNames(schemas: readonly SchemaObject[]): Set<string> {
  const names = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node !== null && typeof node === "object") {
      const { format } = node as { format?: unknown };
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
 * The code of a keyword on a `{"$bytes": n}` member: its attachment, read from the check's
 * context, passes `isAccepted`. Without the context, or with no such attachment, it fails.
 */
function attachmentCode(isAccepted: (attachment: Code, schema: Code | number) => Code) {
  return (cxt: KeywordCxt): void => {
    const { data, schema } = cxt;
    const attachment = _`this.attachments[${data}.$bytes]`;
    cxt.fail(
      _`!(${data} && typeof ${data} == "object" && Number.isInteger(${data}.$bytes) && this && Array.isArray(this.attachments) && ${attachment} instanceof Uint8Array && ${isAccepted(attachment, schema as Code | number)})`,
    );
  };
}

/**
 * The code of `defaultAmongOptions`: a question with option rows starts from its own options, so
 * each label its `default` names, one text or several, is one option's `label`.
 */
function defaultAmongOptionsCode(cxt: KeywordCxt): void {
  const { gen, data } = cxt;
  const isAmongOptions = gen.let("isAmongOptions", true);
  gen.if(_`Array.isArray(${data}.options) && ${data}.options.length > 0`, () => {
    const labels = gen.const(
      "labels",
      _`typeof ${data}.default == "string" ? [${data}.default] : Array.isArray(${data}.default) ? ${data}.default : []`,
    );
    gen.forOf("label", labels, (label) => {
      const isOption = gen.let("isOption", false);
      gen.forOf("option", _`${data}.options`, (option) => {
        gen.if(_`${option} && ${option}.label === ${label}`, () => gen.assign(isOption, true));
      });
      gen.if(_`!${isOption}`, () => gen.assign(isAmongOptions, false));
    });
  });
  cxt.pass(isAmongOptions);
}

/**
 * Compiles the checks of a generation run: every definition of `modules` is added as a schema of
 * its own under its reference, and the definitions `checkedNames` lists for each module are
 * compiled with every definition they reach. Each reference is a call, never inlined, so a
 * definition's check is written once.
 */
export function createCheckCompiler(
  modules: readonly ContractModule[],
  checkedNames: (module: ContractModule) => readonly string[],
): CheckCompiler {
  // A number format is Ajv's object form, so its check runs on numbers and its code calls
  // `SCHEMA_FORMATS[name].validate`; a string format is a bare function.
  const formats = Object.fromEntries(
    [...formatNames(modules.map((module) => module.schema))].map((name) => [
      name,
      NUMBER_FORMAT_NAME.test(name)
        ? { type: "number" as const, validate: (): boolean => true }
        : (): boolean => true,
    ]),
  );
  const ajv = new Ajv2020({
    strict: true,
    $data: true,
    // Picks a tagged union's arm by its `discriminator`.
    discriminator: true,
    // A check stops at its first fault: every fault would keep a refused value's slow keywords
    // running, and a reader records only where the value failed.
    allErrors: false,
    messages: false,
    passContext: true,
    // A reference calls its definition's one function instead of copying its check in place.
    inlineRefs: false,
    // Generation only needs each format's name and kind: the code reads `SCHEMA_FORMATS`.
    formats,
    code: { source: true, esm: true, lines: false, optimize: true, formats: _`SCHEMA_FORMATS` },
  });
  // Ajv registers `discriminator` after `unevaluatedProperties`, which then compiles before the
  // chosen arm's members count as evaluated and refuses a tagged union's own tag. Registered
  // before it, the union's members are evaluated first, as without the discriminator.
  const discriminator = ajv.getKeyword("discriminator");
  if (typeof discriminator !== "object") {
    throw new Error("Ajv has no discriminator keyword to order");
  }
  ajv.removeKeyword("discriminator");
  ajv.addKeyword({ ...discriminator, before: "unevaluatedProperties" });
  ajv.addKeyword({ keyword: "tsType", schemaType: "string" });
  ajv.addKeyword({
    keyword: "minBytes",
    schemaType: "number",
    code: attachmentCode((attachment, bound) => _`${attachment}.byteLength >= ${bound}`),
  });
  ajv.addKeyword({
    keyword: "maxBytes",
    schemaType: "number",
    code: attachmentCode((attachment, bound) => _`${attachment}.byteLength <= ${bound}`),
  });
  ajv.addKeyword({
    keyword: "evenBytes",
    schemaType: "boolean",
    metaSchema: { const: true },
    code: attachmentCode((attachment) => _`${attachment}.byteLength % 2 === 0`),
  });
  // A string's own UTF-8 length, as garde's `length(bytes)` counts it.
  ajv.addKeyword({
    keyword: "maxUtf8Bytes",
    type: "string",
    schemaType: "number",
    code: (cxt) => cxt.fail(_`new TextEncoder().encode(${cxt.data}).byteLength > ${cxt.schema}`),
  });
  // A value's JSON bytes with its attachments, as the Rust contracts' byte caps measure them.
  ajv.addKeyword({
    keyword: "maxJsonBytes",
    schemaType: "number",
    code: (cxt) =>
      cxt.fail(
        _`${new Name(WIRE_BYTE_LENGTH)}(${cxt.data}, this && this.attachments) > ${cxt.schema}`,
      ),
  });
  // A list whose items may not repeat their value at one member, as the Rust list's key refuses.
  ajv.addKeyword({
    keyword: "uniqueItemKey",
    type: "array",
    schemaType: "string",
    code: (cxt) => cxt.fail(_`${new Name(REPEATS_ITEM_KEY)}(${cxt.data}, ${cxt.schema})`),
  });
  ajv.addKeyword({
    keyword: "defaultAmongOptions",
    type: "object",
    schemaType: "boolean",
    metaSchema: { const: true },
    code: defaultAmongOptionsCode,
  });
  for (const module of modules) {
    for (const [name, schema] of Object.entries(definitionsOf(module))) {
      ajv.addSchema(schema, definitionKey(module.path, name));
    }
  }
  for (const module of modules) {
    for (const name of checkedNames(module)) {
      if (ajv.getSchema(definitionKey(module.path, name)) === undefined) {
        throw new Error(`${module.path}: ${name} did not compile`);
      }
    }
  }
  const definitionOf = new Map<string, CompiledDefinition>();
  for (const module of modules) {
    for (const name of Object.keys(definitionsOf(module))) {
      const validateName =
        ajv.schemas[definitionKey(module.path, name)]?.validate?.source?.validateName;
      if (validateName !== undefined) {
        definitionOf.set(String(validateName), { module: module.path, name });
      }
    }
  }
  return { ajv, definitionOf };
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
const AJV_EVALUATED = /^(validate\d+)\.evaluated = (.*);$/u;

/** How many times each identifier occurs in `code`, a word inside a string included. */
function identifierCounts(code: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [word] of code.matchAll(/[A-Za-z_$][\w$]*/gu)) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return counts;
}

/** Each top-level `const` of `statements` that no other statement reads, removed until none is. */
function withoutUnreadConstants(statements: readonly string[]): string[] {
  let kept = [...statements];
  for (;;) {
    const counts = identifierCounts(kept.join("\n"));
    const read = kept.filter((statement) => {
      const constant = /^const ([\w$]+)/u.exec(statement);
      return constant === null || (counts.get(constant[1]!) ?? 0) > 1;
    });
    if (read.length === kept.length) {
      return kept;
    }
    kept = read;
  }
}

/**
 * Generates the checks file of `module`'s definitions that `compiler` compiled, from
 * {@link createCheckCompiler}: one exported function per definition, named by
 * {@link checkName}, calling another module's definition through its owner's checks file. Adds
 * the imports the code needs to `imports`, the checks file's, and returns the code with the names
 * of the checks it exports.
 */
export function generateChecks(
  module: ContractModule,
  compiler: CheckCompiler,
  imports: ModuleImports,
): { readonly code: string; readonly checkNames: readonly string[] } {
  const compiledNames = Object.keys(definitionsOf(module)).filter(
    (name) => compiler.ajv.schemas[definitionKey(module.path, name)]?.validate !== undefined,
  );
  if (compiledNames.length === 0) {
    return { code: "", checkNames: [] };
  }
  const definitionOf = (functionName: string): CompiledDefinition => {
    const definition = compiler.definitionOf.get(functionName);
    if (definition === undefined) {
      throw new Error(`${module.path}: Ajv wrote ${functionName}, which checks no one definition`);
    }
    return definition;
  };
  const exportsByName = Object.fromEntries(
    compiledNames.map((name) => [checkName(name), definitionKey(module.path, name)]),
  );
  const statements = splitStatements(standaloneCode.default(compiler.ajv, exportsByName));

  // Another module's function is that module's to write; this one imports it. A function Ajv
  // writes twice, as it does for a definition that reaches itself, is kept once.
  const own = [...new Set(statements)].filter((statement) => {
    if (statement === '"use strict";' || AJV_EXPORT.test(statement)) {
      return false;
    }
    const functionName =
      AJV_FUNCTION_HEAD.exec(statement)?.[1] ?? AJV_EVALUATED.exec(statement)?.[1];
    return functionName === undefined || definitionOf(functionName).module === module.path;
  });

  // Ajv's code is plain JavaScript: its locals and helpers are typed `any` so it compiles under
  // the package's strict settings, and each check is a typed constant whose function answers a
  // type predicate. A constant, not a declaration: a declared function's own properties have no
  // type an isolated declaration can state.
  imports.addFromHandWrittenModule(SCHEMA_CHECK_MODULE, "CompiledSchemaCheck", "type");
  // A check's `evaluated` record is set in its constant, never by a statement of its own: a
  // bundler keeps every top-level assignment, which would keep every check a page never calls.
  const evaluatedOf = new Map(
    own.flatMap((statement) => {
      const evaluated = AJV_EVALUATED.exec(statement);
      return evaluated === null ? [] : [[evaluated[1]!, evaluated[2]!] as const];
    }),
  );
  const checkNames: string[] = [];
  const typed = own.flatMap((statement): string[] => {
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
    if (AJV_EVALUATED.test(statement)) {
      return [];
    }
    const head = AJV_FUNCTION_HEAD.exec(statement);
    if (head === null) {
      return [statement];
    }
    const functionName = head[1]!;
    const checkedType = definitionOf(functionName).name;
    imports.addFromModule(module.path, checkedType, "type");
    checkNames.push(checkName(checkedType));
    const evaluated = evaluatedOf.get(functionName);
    const typedHead =
      `/** Checks that a value is a {@link ${checkedType}}. */\n` +
      `export const ${functionName}: CompiledSchemaCheck<${checkedType}> = ` +
      (evaluated === undefined ? "" : "/* @__PURE__ */ Object.assign(") +
      `function (this: any, data: any, ` +
      `{instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {})` +
      `: data is ${checkedType} {`;
    // A check reads the `props` or `items` of another's `evaluated`, which one object
    // literal's inferred type may lack.
    const tail = evaluated === undefined ? "" : `, { evaluated: ${evaluated} as any })`;
    const body = replaceOutsideStrings(statement.slice(head[0].length), (part) =>
      part
        .replace(/\b(let|var|const) (\w+) = /gu, "$1 $2: any = ")
        .replace(/\b(let|var) (\w+);/gu, "$1 $2: any;")
        // A check another calls has recorded what it evaluated by the time it is read.
        .replace(/\.evaluated\.(props|items)\b/gu, ".evaluated!.$1")
        // `multipleOf` guards its literal divisor against zero, which TypeScript refuses as a
        // comparison of two constants.
        .replace(/\((\d+(?:\.\d+)?) === 0 \|\| \(/gu, "(($1 as number) === 0 || ("),
    );
    return [`${typedHead}${body}${tail};`];
  });

  // Each function takes its definition's check name, here and in every call to it.
  const named = withoutUnreadConstants(
    typed.map((statement) =>
      replaceOutsideStrings(statement, (part) =>
        part.replace(/\bvalidate\d+\b/gu, (functionName) =>
          checkName(definitionOf(functionName).name),
        ),
      ),
    ),
  );
  const ownerOf = new Map(
    [...compiler.definitionOf.values()].map((definition) => [
      checkName(definition.name),
      definition.module,
    ]),
  );
  for (const word of identifierCounts(named.join("\n")).keys()) {
    const owner = ownerOf.get(word);
    if (owner !== undefined && owner !== module.path) {
      imports.addFromModule(checksModulePath(owner), word, "value");
    }
  }
  for (const value of RUN_TIME_VALUES) {
    if (named.some((statement) => statement.includes(value))) {
      imports.addFromHandWrittenModule(SCHEMA_CHECK_MODULE, value, "value");
    }
  }
  // A recursive reference holds its function in a wrapper made at load, so the wrappers come
  // after every function's constant they name.
  const isWrapper = (statement: string): boolean => /^const wrapper\d+ = /u.test(statement);
  const code = [...named.filter((statement) => !isWrapper(statement)), ...named.filter(isWrapper)]
    .map((statement) =>
      statement.startsWith("/**")
        ? statement.replace("*/\n", "*/\n// prettier-ignore\n")
        : `// prettier-ignore\n${statement}`,
    )
    .join("\n");
  return { code, checkNames: checkNames.sort() };
}
