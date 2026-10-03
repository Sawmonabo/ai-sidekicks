// Import aliases for Vite, spread into the build's three targets and every Vitest project. The
// map lives in `tsconfig.paths.json`, which the compiler, dependency-cruiser and knip also read.
// It is spread into each project because none uses `extends: true`, so a root `resolve.alias`
// would reach none of them.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const pathsConfig = JSON.parse(
  readFileSync(resolve(PACKAGE_ROOT, "tsconfig.paths.json"), "utf8"),
) as { readonly compilerOptions: { readonly paths: Readonly<Record<string, readonly string[]>> } };

/** One Vite alias per `tsconfig.paths.json` entry, such as `@renderer/x` for a folder. */
export const PATH_ALIASES: readonly { readonly find: string; readonly replacement: string }[] =
  Object.entries(pathsConfig.compilerOptions.paths).map(([pattern, [target]]) => {
    if (target === undefined || !pattern.endsWith("/*") || !target.endsWith("/*")) {
      throw new Error(`tsconfig.paths.json: "${pattern}" must map "<alias>/*" to one "<folder>/*"`);
    }
    return {
      find: pattern.slice(0, -"/*".length),
      replacement: resolve(PACKAGE_ROOT, target.slice(0, -"/*".length)),
    };
  });
