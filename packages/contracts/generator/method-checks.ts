// Writes the index of every query's and mutation's checks: for each method, a loader that imports
// its request check and its reply check from their owners' checks files, on first use. A client
// that checks its calls loads only the checks of the methods it calls, so none of them weighs on
// its start, and no method table, which names every check of its module, is loaded with them.
import type { ContractModule } from "./emit-folder.ts";
import { GENERATED_FOLDER, moduleSpecifier, parseTypeReference } from "./module-imports.ts";
import { checkName, checksModulePath, SCHEMA_CHECK_MODULE } from "./schema-checks.ts";

/** The path, under the generated folder, of the index this module writes. */
export const METHOD_CHECKS_MODULE = "method-checks";

/**
 * The index's source, unformatted, under `header`. Throws when a contract module sits at the
 * index's path, or two tables hold the same method, since the index would then load the wrong
 * checks for it.
 */
export function methodChecksSource(modules: readonly ContractModule[], header: string): string {
  if (modules.some((module) => module.path === METHOD_CHECKS_MODULE)) {
    throw new Error(`a contract module is at ${METHOD_CHECKS_MODULE}, where the index is written`);
  }
  const loaders = new Map<string, string>();
  for (const module of modules) {
    for (const table of module.methodTables) {
      for (const method of table.methods) {
        if (method.procedureType === "subscription") {
          continue;
        }
        if (loaders.has(method.method)) {
          throw new Error(`${method.method} is in two method tables`);
        }
        const request = checkSource(method.params, module.path);
        const response = checkSource(method.result, module.path);
        // The return type is written out, since the package declares its types file by file. Each
        // check is taken by its name from its checks file, so a bundler keeps only those named.
        loaders.set(
          method.method,
          `${JSON.stringify(method.method)}: async (): Promise<MethodCheckPair<` +
            `${request.type}, ${response.type}>> => {\n` +
            `const { ${request.check}: requestCheck } = await import(${request.specifier});\n` +
            `const { ${response.check}: responseCheck } = await import(${response.specifier});\n` +
            "return { requestCheck, responseCheck };\n},",
        );
      }
    }
  }
  const schemaCheck = JSON.stringify(
    moduleSpecifier(`${GENERATED_FOLDER}/${METHOD_CHECKS_MODULE}`, SCHEMA_CHECK_MODULE),
  );
  return [
    header,
    "// Each query's and mutation's two checks, loaded on first use from their checks files.",
    `import type { SchemaCheck } from ${schemaCheck};`,
    "/** One method's request check and reply check. */\n" +
      "export interface MethodCheckPair<Request, Response> {\n" +
      "readonly requestCheck: SchemaCheck<Request>;\n" +
      "readonly responseCheck: SchemaCheck<Response>;\n}",
    "/** Each query's and mutation's checks loader, by the method's wire name. */\n" +
      `export const METHOD_CHECK_LOADERS = {\n${[...loaders.keys()]
        .sort()
        .map((method) => loaders.get(method))
        .join("\n")}\n} as const;`,
  ].join("\n\n");
}

/** Where a method's check comes from: its checks file, its name there and the type it admits. */
function checkSource(
  reference: string,
  modulePath: string,
): { readonly specifier: string; readonly check: string; readonly type: string } {
  const target = parseTypeReference(reference, modulePath);
  const owner = target.module ?? modulePath;
  const typeSpecifier = JSON.stringify(moduleSpecifier(METHOD_CHECKS_MODULE, owner));
  return {
    specifier: JSON.stringify(moduleSpecifier(METHOD_CHECKS_MODULE, checksModulePath(owner))),
    check: checkName(target.name),
    type: `import(${typeSpecifier}).${target.name}`,
  };
}
