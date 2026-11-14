// Writes one contract module's TypeScript files, formatted by the repository's Prettier: the
// module's own, with its imports, constants, refusal codes, types, method tables and the export of
// its checks, and its checks file, which holds the checks themselves.
import { fileURLToPath } from "node:url";

import { format, resolveConfig } from "prettier";

import type { ContractModule, MethodTable, RefusalCodes } from "./emit-folder.ts";
import {
  ModuleImports,
  moduleSpecifier,
  parseTypeReference,
  type TypeReference,
} from "./module-imports.ts";
import {
  SCHEMA_CHECK_MODULE,
  type CheckCompiler,
  checkName,
  checksModulePath,
  generateChecks,
} from "./schema-checks.ts";
import { generateTypes } from "./type-declarations.ts";

/** The two lines every generated file opens with. */
export const GENERATED_HEADER: string =
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

/**
 * The names of this module's definitions that get a check: listed ones and every one a method
 * table names, in this module or another, since a table imports its checks from their owner.
 */
export function checkedDefinitions(
  module: ContractModule,
  allModules: readonly ContractModule[],
): string[] {
  const tableTypes = allModules.flatMap((owner) =>
    methodTypeReferences(owner)
      .filter((reference) => (reference.module ?? owner.path) === module.path)
      .map((reference) => reference.name),
  );
  return [...new Set([...module.checks, ...tableTypes])].sort();
}

function writeMethodTable(
  table: MethodTable,
  module: ContractModule,
  imports: ModuleImports,
): string {
  const typeName = tableTypeName(table);
  imports.addFromHandWrittenModule(SCHEMA_CHECK_MODULE, "SchemaCheck", "type");
  const resolve = (reference: string): string => {
    const target = parseTypeReference(reference, module.path);
    if (target.module !== undefined) {
      imports.addFromModule(target.module, target.name, "type");
    }
    imports.addFromModule(
      checksModulePath(target.module ?? module.path),
      checkName(target.name),
      "value",
    );
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
      // A table reads its checks at load from checks files, which import no module's values
      // back, so each check is made first. Each freeze is marked pure, so a bundle that reads no
      // table leaves the table and its checks out.
      value:
        `${key}: /* @__PURE__ */ Object.freeze({ method: ${key}, ` +
        `procedureType: ${JSON.stringify(method.procedureType)}, ` +
        `mutating: ${String(method.mutating)}, ` +
        checks.map(([member, name]) => `${member}: ${checkName(name)}`).join(", ") +
        " }),",
    };
  });
  return [
    docComment(`The methods of {@link ${table.name}}, each with its checks.`),
    `export interface ${typeName} {\n${members.map((member) => member.type).join("\n")}\n}`,
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
 * The files of `module`. `allModules` holds every module, for references and method tables
 * across modules; `refusalCodes` is written here when this module owns them; the checks come
 * from `checkCompiler`, the run's one compile of every check.
 */
export async function writeModuleFiles(
  module: ContractModule,
  allModules: readonly ContractModule[],
  refusalCodes: RefusalCodes,
  checkCompiler: CheckCompiler,
): Promise<ModuleFiles> {
  const definitions = Object.keys((module.schema["$defs"] ?? {}) as Record<string, unknown>);
  const checked = checkedDefinitions(module, allModules);
  for (const name of checked) {
    if (!definitions.includes(name)) {
      throw new Error(`${module.path}: ${name} is checked but is not one of its definitions`);
    }
  }
  const localNames = new Set([
    ...definitions,
    ...module.constants.map((constant) => constant.name),
    ...module.methodTables.flatMap((table) => [table.name, tableTypeName(table)]),
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
export async function formatGenerated(source: string): Promise<string> {
  const prettierConfig = await resolveConfig(fileURLToPath(import.meta.url));
  return format(source, { ...prettierConfig, parser: "typescript" });
}
