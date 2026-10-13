// Bundles each entry module in `src/` into `dist/<engine>.mjs`, one ES module per engine with every
// package it imports, which the daemon embeds and compiles on that engine's thread. Beside each
// bundle, `dist/<engine>.notices.txt` holds the license of every package bundled into it.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const PACKAGE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_DIRECTORY = path.join(PACKAGE_DIRECTORY, "src");
const DIST_DIRECTORY = path.join(PACKAGE_DIRECTORY, "dist");

/** A package's legal files, by the names packages ship them under (`LICENSE.md`, `COPYING`, …). */
const LEGAL_FILE_NAME = /^(licen[cs]e|copying|notice)/i;

/** The entry modules, one per engine; none until an engine's code is written. */
function readEntryFiles() {
  if (!existsSync(SOURCE_DIRECTORY)) {
    return [];
  }
  return readdirSync(SOURCE_DIRECTORY, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.m?js$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/** The folder of the npm package an input file belongs to, or none for this package's own files. */
function findPackageDirectory(inputPath) {
  let directory = path.dirname(path.resolve(PACKAGE_DIRECTORY, inputPath));
  while (directory.includes(`${path.sep}node_modules${path.sep}`)) {
    if (existsSync(path.join(directory, "package.json"))) {
      const manifest = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
      if (
        typeof manifest.name === "string" &&
        directory.endsWith(path.join(...manifest.name.split("/")))
      ) {
        return directory;
      }
    }
    directory = path.dirname(directory);
  }
  return undefined;
}

/** One package's notice: its name, version and license, then the text of each legal file. */
function composeNotice(packageDirectory) {
  const manifest = JSON.parse(readFileSync(path.join(packageDirectory, "package.json"), "utf8"));
  const legalFiles = readdirSync(packageDirectory)
    .filter((name) => LEGAL_FILE_NAME.test(name))
    .sort();
  if (legalFiles.length === 0) {
    throw new Error(`${manifest.name} ${manifest.version} ships no license file to carry`);
  }
  const texts = legalFiles.map((name) =>
    readFileSync(path.join(packageDirectory, name), "utf8").trimEnd(),
  );
  return [`${manifest.name} ${manifest.version} (${manifest.license})`, ...texts].join("\n\n");
}

rmSync(DIST_DIRECTORY, { recursive: true, force: true });
mkdirSync(DIST_DIRECTORY, { recursive: true });

for (const entryFile of readEntryFiles()) {
  const engine = path.basename(entryFile, path.extname(entryFile));
  const outfile = path.join(DIST_DIRECTORY, `${engine}.mjs`);
  const result = await build({
    absWorkingDir: PACKAGE_DIRECTORY,
    entryPoints: [path.join(SOURCE_DIRECTORY, entryFile)],
    outfile,
    bundle: true,
    format: "esm",
    platform: "browser",
    minify: true,
    metafile: true,
    logLevel: "warning",
  });
  const packageDirectories = new Set();
  for (const inputPath of Object.keys(result.metafile.inputs)) {
    const packageDirectory = findPackageDirectory(inputPath);
    if (packageDirectory !== undefined) {
      packageDirectories.add(packageDirectory);
    }
  }
  const notices = [...packageDirectories].sort().map(composeNotice);
  writeFileSync(
    path.join(DIST_DIRECTORY, `${engine}.notices.txt`),
    `${notices.join("\n\n---\n\n")}\n`,
  );
}
