// Bundles the daemon: its modules and the TypeScript workspace packages it imports, with what those
// import, are inlined into a few files, since loading them one file at a time was most of its
// start; every other package it lists, the native ones among them, loads from its node_modules.
// Each worker thread and child process is an entry written where its source sits, and a module
// that finds a file from its own location keeps its source path in a chunk of its own, so the
// worker beside the module that starts it and the package's manifest are found from the build as
// from the source. `tsc` writes only the declarations.
import { globSync, readFileSync } from "node:fs";
import path from "node:path";

import type { RolldownOptions } from "rolldown";

const SOURCE_FOLDER = path.join(import.meta.dirname, "src");

const manifest = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "package.json"), "utf8"),
) as {
  dependencies: Record<string, string>;
};

// The condition a TypeScript workspace package's exports carry, pointing at its source.
const SOURCE_CONDITION = "@ai-sidekicks/source";

// Whether an exports map names the source condition anywhere in it.
function namesSourceCondition(exportsMap: unknown): boolean {
  return (
    typeof exportsMap === "object" &&
    exportsMap !== null &&
    Object.entries(exportsMap).some(
      ([condition, target]) => condition === SOURCE_CONDITION || namesSourceCondition(target),
    )
  );
}

const INSTALLED_PACKAGES = Object.keys(manifest.dependencies).filter((name) => {
  const dependencyManifest = JSON.parse(
    readFileSync(path.join(import.meta.dirname, "node_modules", name, "package.json"), "utf8"),
  ) as { exports?: unknown };
  return !namesSourceCondition(dependencyManifest.exports);
});

// A worker thread's module is `worker.ts` beside the module that starts it, and a child process's
// is `child.ts` beside the module that forks it.
const WORKER_ENTRIES = globSync(["**/worker.ts", "**/child.ts"], {
  cwd: SOURCE_FOLDER,
  exclude: ["**/__tests__/**"],
});

// A source module's path inside the source folder, without its extension: its name in the build.
function buildNameOf(sourcePath: string): string {
  return path.relative(SOURCE_FOLDER, sourcePath).replace(/\.ts$/, "").split(path.sep).join("/");
}

const ENTRY_PATHS = [
  path.join(SOURCE_FOLDER, "main.ts"),
  ...WORKER_ENTRIES.map((entry) => path.join(SOURCE_FOLDER, entry)),
];

// A line of code, not of a comment, that reads the module's own URL, folder or file path.
const OWN_LOCATION_IN_CODE = /^(?!\s*(?:\/\/|\/?\*)).*\bimport\.meta\.(?:url|dirname|filename)\b/m;

// The modules that find a file from their own location, entries aside, which keep theirs already.
function readsItsOwnLocation(modulePath: string): boolean {
  return (
    modulePath.startsWith(SOURCE_FOLDER + path.sep) &&
    modulePath.endsWith(".ts") &&
    !ENTRY_PATHS.includes(modulePath) &&
    OWN_LOCATION_IN_CODE.test(readFileSync(modulePath, "utf8"))
  );
}

const keptPathNames = new Set<string>();

const config: RolldownOptions = {
  input: Object.fromEntries(ENTRY_PATHS.map((entry) => [buildNameOf(entry), entry])),
  platform: "node",
  external: (id) => INSTALLED_PACKAGES.some((name) => id === name || id.startsWith(`${name}/`)),
  output: {
    dir: path.join(import.meta.dirname, "dist"),
    format: "esm",
    sourcemap: true,
    entryFileNames: "[name].js",
    chunkFileNames: (chunk) =>
      keptPathNames.has(chunk.name) ? "[name].js" : "chunks/[name]-[hash].js",
    codeSplitting: {
      groups: [
        {
          debugName: "modules that read their own location",
          name: (moduleId) => {
            // An id is the module's absolute path, written with the platform's separators or not.
            const modulePath = path.resolve(moduleId);
            if (!readsItsOwnLocation(modulePath)) {
              return null;
            }
            const name = buildNameOf(modulePath);
            keptPathNames.add(name);
            return name;
          },
        },
      ],
    },
  },
};

export default config;
