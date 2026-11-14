// Writes one contract module's TypeScript files, formatted by the repository's Prettier: the
// module's own, with its imports, constants, refusal codes, types, method tables with each
// method's types, and the export of its checks, and its checks file, which holds the checks
// themselves.
import { fileURLToPath } from "node:url";

import { format, resolveConfig } from "prettier";

import type { ContractModule, MethodTable, RefusalCodes } from "./emit-folder.ts";
import { ModuleImports, moduleSpecifier, parseTypeReference } from "./module-imports.ts";
import {
  type CheckCompiler,
  checkName,
  checksModulePath,
  generateChecks,
} from "./schema-checks.ts";
import { generateTypes } from "./type-declarations.ts";

/** The two lines every generated file opens with. */
const GENERATED_HEADER: string =
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

/**
 * The name of a table's type: the emitted one, else `TABLE_METHOD_DESCRIPTORS` as
 * `TableMethodDescriptors`.
 */
function tableTypeName(table: MethodTable): string {
  if (table.typeName !== undefined) {
    return table.typeName;
  }
  return table.name
    .toLowerCase()
    .split("_")
    .map((word) => `${word[0]!.toUpperCase()}${word.slice(1)}`)
    .join("");
}

/** The word every table's type ends in, which its type map swaps for `Types`. */
const DESCRIPTORS_SUFFIX = "Descriptors";

/** The name of a table's type map: `TableMethodDescriptors` as `TableMethodTypes`. */
function tableTypesName(table: MethodTable): string {
  const typeName = tableTypeName(table);
  if (!typeName.endsWith(DESCRIPTORS_SUFFIX)) {
    throw new Error(`${table.name}: its type ${typeName} does not end in ${DESCRIPTORS_SUFFIX}`);
  }
  return `${typeName.slice(0, -DESCRIPTORS_SUFFIX.length)}Types`;
}

function writeMethodTable(
  table: MethodTable,
  module: ContractModule,
  imports: ModuleImports,
): string {
  const typeName = tableTypeName(table);
  const resolve = (reference: string): string => {
    const target = parseTypeReference(reference, module.path);
    if (target.module !== undefined) {
      imports.addFromModule(target.module, target.name, "type");
    }
    return target.name;
  };
  const members = table.methods.map((method) => {
    const types: [string, string][] = [
      ["params", resolve(method.params)],
      ["result", resolve(method.result)],
      ...(method.emission === undefined
        ? []
        : [["emission", resolve(method.emission)] as [string, string]]),
    ];
    const key = JSON.stringify(method.method);
    return {
      type:
        `readonly ${key}: { readonly method: ${key}; ` +
        `readonly procedureType: ${JSON.stringify(method.procedureType)}; ` +
        `readonly mutating: ${String(method.mutating)}; };`,
      types: `readonly ${key}: { ${types
        .map(([member, name]) => `readonly ${member}: ${name};`)
        .join(" ")} };`,
      // Each freeze is marked pure, so a bundle that reads no table leaves the table out.
      value:
        `${key}: /* @__PURE__ */ Object.freeze({ method: ${key}, ` +
        `procedureType: ${JSON.stringify(method.procedureType)}, ` +
        `mutating: ${String(method.mutating)} }),`,
    };
  });
  return [
    docComment(`The methods of {@link ${table.name}}, each with its kind.`),
    `export interface ${typeName} {\n${members.map((member) => member.type).join("\n")}\n}`,
    docComment(`The params, result and emission types of each method of {@link ${table.name}}.`),
    `export interface ${tableTypesName(table)} {\n${members
      .map((member) => member.types)
      .join("\n")}\n}`,
    docComment(table.doc),
    `export const ${table.name}: ${typeName} = /* @__PURE__ */ Object.freeze({\n${members
      .map((member) => member.value)
      .join("\n")}\n});`,
  ].join("\n");
}

/** One contract module's two files, complete and formatted. */
export interface ModuleFiles {
  readonly module: string;
  /** The checks file, at {@link checksModulePath}, or undefined for a module with no checks. */
  readonly checks: string | undefined;
}

/**
 * The files of `module`. `refusalCodes` is written here when this module owns them; the checks
 * come from `checkCompiler`, the run's one compile of every check.
 */
export async function writeModuleFiles(
  module: ContractModule,
  refusalCodes: RefusalCodes,
  checkCompiler: CheckCompiler,
): Promise<ModuleFiles> {
  const definitions = Object.keys((module.schema["$defs"] ?? {}) as Record<string, unknown>);
  for (const name of module.checks) {
    if (!definitions.includes(name)) {
      throw new Error(`${module.path}: ${name} is checked but is not one of its definitions`);
    }
  }
  const localNames = new Set([
    ...definitions,
    ...module.constants.map((constant) => constant.name),
    ...module.methodTables.flatMap((table) => [
      table.name,
      tableTypeName(table),
      tableTypesName(table),
    ]),
    ...(refusalCodes.module === module.path ? [refusalCodes.name] : []),
  ]);
  const imports = new ModuleImports(module.path, localNames);

  const constants = module.constants.map((constant) => {
    const head = `${docComment(constant.doc)}\nexport const ${constant.name}`;
    const value = JSON.stringify(constant.value);
    if (constant.typeName === undefined) {
      return `${head} = ${value} as const;`;
    }
    const type = parseTypeReference(constant.typeName, module.path);
    if (type.module !== undefined) {
      imports.addFromModule(type.module, type.name, "type");
    }
    return `${head}: Readonly<${type.name}> = ${value};`;
  });
  const refusals =
    refusalCodes.module === module.path
      ? [
          `${docComment(refusalCodes.doc)}\nexport type ${refusalCodes.name} = ${refusalCodes.codes
            .map((code) => JSON.stringify(code))
            .join(" | ")};`,
        ]
      : [];
  const types = await generateTypes(module.schema, imports);
  const checksPath = checksModulePath(module.path);
  const checksImports = new ModuleImports(checksPath, new Set(definitions.map(checkName)));
  const checks = generateChecks(module, checkCompiler, checksImports);
  const tables = module.methodTables.map((table) => writeMethodTable(table, module, imports));
  const checksExport =
    checks.checkNames.length === 0
      ? ""
      : `export { ${checks.checkNames.join(", ")} } from ${JSON.stringify(
          moduleSpecifier(module.path, checksPath),
        )};`;
  const docLines = module.doc
    .split("\n")
    .map((line) => (line === "" ? "//" : `// ${line}`))
    .join("\n");

  const source = [
    GENERATED_HEADER,
    docLines,
    imports.render(),
    ...constants,
    ...refusals,
    types,
    checksExport,
    ...tables,
  ]
    .filter((part) => part !== "")
    .join("\n\n");
  return {
    module: await formatGenerated(source),
    checks:
      checks.code === ""
        ? undefined
        : await formatGenerated(
            [GENERATED_HEADER, docLines, checksImports.render(), checks.code].join("\n\n"),
          ),
  };
}

/** `source` formatted by the repository's Prettier, as every generated file is written. */
async function formatGenerated(source: string): Promise<string> {
  const prettierConfig = await resolveConfig(fileURLToPath(import.meta.url));
  return format(source, { ...prettierConfig, parser: "typescript" });
}
