// Writes one contract module's TypeScript file: the generated header, its imports, constants,
// refusal codes, types, checks and method tables, formatted by the repository's Prettier.
import { fileURLToPath } from "node:url";

import type { SchemaObject } from "ajv/dist/2020.js";
import { format, resolveConfig } from "prettier";

import type { ContractModule, MethodTable, RefusalCodes } from "./emit-folder.ts";
import { ModuleImports, parseTypeReference, type TypeReference } from "./module-imports.ts";
import { checkName, generateChecks } from "./schema-checks.ts";
import { generateTypes } from "./type-declarations.ts";

const GENERATED_HEADER =
  "// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.\n" +
  "// Change the Rust source and regenerate; never edit this file.";

/** `text` as a block comment, one `*` line per line of text. */
function docComment(text: string): string {
  if (!text.includes("\n")) {
    return `/** ${text} */`;
  }
  return `/**\n${text
    .split("\n")
    .map((line) => (line === "" ? " *" : ` * ${line}`))
    .join("\n")}\n */`;
}

/** `TABLE_METHOD_DESCRIPTORS` as `TableMethodDescriptors`, the name of the table's type. */
function tableTypeName(tableName: string): string {
  return tableName
    .toLowerCase()
    .split("_")
    .map((word) => `${word[0]!.toUpperCase()}${word.slice(1)}`)
    .join("");
}

/** Every definition a method table checks, local or in another module. */
function methodTypeReferences(module: ContractModule): TypeReference[] {
  return module.methodTables.flatMap((table) =>
    table.methods.flatMap((method) =>
      [
        method.params,
        method.result,
        ...(method.emission === undefined ? [] : [method.emission]),
      ].map((reference) => parseTypeReference(reference, module.path)),
    ),
  );
}

/** The names of this module's definitions that get a check: listed ones and every method type. */
function checkedDefinitions(module: ContractModule): string[] {
  const local = methodTypeReferences(module)
    .filter((reference) => reference.module === undefined)
    .map((reference) => reference.name);
  return [...new Set([...module.checks, ...local])].sort();
}

function writeMethodTable(
  table: MethodTable,
  module: ContractModule,
  imports: ModuleImports,
): string {
  const typeName = tableTypeName(table.name);
  const resolve = (reference: string): string => {
    const target = parseTypeReference(reference, module.path);
    if (target.module !== undefined) {
      imports.addFromModule(target.module, target.name, "type");
      imports.addFromModule(target.module, checkName(target.name), "value");
    }
    return target.name;
  };
  const members = table.methods.map((method) => {
    const checks: [string, string][] = [
      ["requestCheck", resolve(method.params)],
      ["responseCheck", resolve(method.result)],
      ...(method.emission === undefined
        ? []
        : [["emissionCheck", resolve(method.emission)] as [string, string]]),
    ];
    const key = JSON.stringify(method.method);
    return {
      type:
        `readonly ${key}: { readonly method: ${key}; ` +
        `readonly procedureType: ${JSON.stringify(method.procedureType)}; ` +
        `readonly mutating: ${String(method.mutating)}; ` +
        checks.map(([member, name]) => `readonly ${member}: SchemaCheck<${name}>;`).join(" ") +
        " };",
      value:
        `${key}: Object.freeze({ method: ${key}, procedureType: ${JSON.stringify(method.procedureType)}, ` +
        `mutating: ${String(method.mutating)}, ` +
        checks.map(([member, name]) => `${member}: ${checkName(name)}`).join(", ") +
        " }),",
    };
  });
  return [
    docComment(`The methods of {@link ${table.name}}, each with its checks.`),
    `export interface ${typeName} {\n${members.map((member) => member.type).join("\n")}\n}`,
    docComment(table.doc),
    `export const ${table.name}: ${typeName} = Object.freeze({\n${members
      .map((member) => member.value)
      .join("\n")}\n});`,
  ].join("\n");
}

/**
 * The complete, formatted file for `module`. `allSchemas` holds every module's schema, for
 * references across modules; `refusalCodes` is written here when this module owns them.
 */
export async function writeModuleFile(
  module: ContractModule,
  allSchemas: readonly SchemaObject[],
  refusalCodes: RefusalCodes,
): Promise<string> {
  const definitions = Object.keys((module.schema["$defs"] ?? {}) as Record<string, unknown>);
  const checked = checkedDefinitions(module);
  for (const name of checked) {
    if (!definitions.includes(name)) {
      throw new Error(`${module.path}: ${name} is checked but is not one of its definitions`);
    }
  }
  const localNames = new Set([
    ...definitions,
    ...checked.map(checkName),
    ...module.constants.map((constant) => constant.name),
    ...module.methodTables.flatMap((table) => [table.name, tableTypeName(table.name)]),
    ...(refusalCodes.module === module.path ? [refusalCodes.name] : []),
  ]);
  const imports = new ModuleImports(module.path, localNames);

  const constants = module.constants.map(
    (constant) =>
      `${docComment(constant.doc)}\nexport const ${constant.name} = ${JSON.stringify(constant.value)} as const;`,
  );
  const refusals =
    refusalCodes.module === module.path
      ? [
          `${docComment(refusalCodes.doc)}\nexport type ${refusalCodes.name} = ${refusalCodes.codes
            .map((code) => JSON.stringify(code))
            .join(" | ")};`,
        ]
      : [];
  const types = await generateTypes(module.schema, imports);
  const checks = generateChecks(module, checked, allSchemas, imports);
  const tables = module.methodTables.map((table) => writeMethodTable(table, module, imports));

  const source = [
    GENERATED_HEADER,
    module.doc
      .split("\n")
      .map((line) => (line === "" ? "//" : `// ${line}`))
      .join("\n"),
    imports.render(),
    ...constants,
    ...refusals,
    types,
    checks,
    ...tables,
  ]
    .filter((part) => part !== "")
    .join("\n\n");
  const prettierConfig = await resolveConfig(fileURLToPath(import.meta.url));
  return format(source, { ...prettierConfig, parser: "typescript" });
}
