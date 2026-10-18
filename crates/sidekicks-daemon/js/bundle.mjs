// Bundles each entry module in `src/` into `dist/<engine>.mjs`, one ES module per engine with every
// package it imports, which the daemon embeds and compiles on that engine's thread. Beside each
// bundle, `dist/<engine>.notices.txt` holds the license of every package bundled into it.
//
// It also writes the TextMate grammars the daemon's colorer runs into `dist/grammars/`: one
// `<name>.json` per grammar the colorable languages' modules carry, `notices.txt` with the license
// of the package they come from and each grammar's upstream source and license, and
// `scopes-named-from-text.json`, the scope names of the grammars that build a scope name from the
// text they match, directly or through a grammar they include, whose highlighter the colorer
// rebuilds after a set amount of such source.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { grammars as grammarSources } from "tm-grammars";

const PACKAGE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_DIRECTORY = path.join(PACKAGE_DIRECTORY, "src");
const DIST_DIRECTORY = path.join(PACKAGE_DIRECTORY, "dist");
const GRAMMAR_DIRECTORY = path.join(DIST_DIRECTORY, "grammars");

/** The `@shikijs/langs` module of each language the daemon colors, the contract's language set. */
const COLORABLE_LANGUAGE_MODULES = [
  "bash",
  "css",
  "diff",
  "go",
  "html",
  "javascript",
  "json",
  "jsx",
  "markdown",
  "python",
  "rust",
  "sql",
  "tsx",
  "typescript",
  "yaml",
];

/** A capture reference in a scope name, `$1` or `${1:/downcase}`, which the engine fills in. */
const CAPTURE_REFERENCE = /\$(?:\d+|\{\d+:\/(?:downcase|upcase)\})/;

/**
 * The license of a grammar whose `tm-grammars` record names none, read from its upstream source at
 * the commit the record names; a record at another commit fails the bundle until it is read again.
 */
const UNRECORDED_GRAMMAR_LICENSES = {
  yaml: {
    sha: "e54ceae3b719506dba7e481a77cea4a8b576ae46",
    license: "MIT",
    licenseUrl:
      "https://github.com/textmate/yaml.tmbundle/blob/e54ceae3b719506dba7e481a77cea4a8b576ae46/Syntaxes/YAML-license.txt",
  },
};

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

/**
 * Every grammar registration the colorable languages' modules carry, by scope name. Throws when a
 * module carries a grammar no colorable language owns, which the colorer would not register, or
 * two modules carry different grammars under one scope name.
 */
async function readGrammars() {
  const registrations = await Promise.all(
    COLORABLE_LANGUAGE_MODULES.map(
      async (language) => (await import(`@shikijs/langs/${language}`)).default,
    ),
  );
  const ownScopeNames = new Set(registrations.map((grammars) => grammars.at(-1).scopeName));
  const grammarsByScopeName = new Map();
  for (const grammar of registrations.flat()) {
    if (!ownScopeNames.has(grammar.scopeName)) {
      throw new Error(`${grammar.scopeName} is embedded but no colorable language owns it`);
    }
    const known = grammarsByScopeName.get(grammar.scopeName);
    if (known !== undefined && JSON.stringify(known) !== JSON.stringify(grammar)) {
      throw new Error(`two modules carry different grammars for ${grammar.scopeName}`);
    }
    grammarsByScopeName.set(grammar.scopeName, grammar);
  }
  return grammarsByScopeName;
}

/** Walks every rule of a grammar, nested rules, captures and injections included. */
function* walkRules(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      yield* walkRules(item);
    }
  } else if (typeof value === "object" && value !== null) {
    yield value;
    for (const child of Object.values(value)) {
      yield* walkRules(child);
    }
  }
}

/** A grammar's top-level patterns, its named rules and its injections. */
function ownRules(grammar) {
  return [grammar.patterns, grammar.repository ?? {}, grammar.injections ?? {}];
}

/** Whether one of the grammar's own rules builds a scope name from the text it matches. */
function namesScopesFromText(grammar) {
  return [...walkRules(ownRules(grammar))].some((rule) =>
    [rule.name, rule.contentName].some(
      (name) => typeof name === "string" && CAPTURE_REFERENCE.test(name),
    ),
  );
}

/** The scope names of the other grammars a grammar includes. */
function readIncludedScopeNames(grammar) {
  const included = new Set();
  for (const rule of walkRules(ownRules(grammar))) {
    if (typeof rule.include === "string" && !/^[#$]/.test(rule.include)) {
      included.add(rule.include.split("#")[0]);
    }
  }
  included.delete(grammar.scopeName);
  return included;
}

/**
 * The scope names of the grammars that build a scope name from matched text, themselves or through
 * a grammar they include, sorted.
 */
function findScopesNamedFromText(grammarsByScopeName) {
  const naming = new Set(
    [...grammarsByScopeName.values()]
      .filter(namesScopesFromText)
      .map((grammar) => grammar.scopeName),
  );
  const includes = new Map(
    [...grammarsByScopeName.values()].map((grammar) => [
      grammar.scopeName,
      readIncludedScopeNames(grammar),
    ]),
  );
  // Grows until no grammar includes a naming grammar outside the set.
  let hasGrown = true;
  while (hasGrown) {
    hasGrown = false;
    for (const [scopeName, includedScopeNames] of includes) {
      if (!naming.has(scopeName) && [...includedScopeNames].some((name) => naming.has(name))) {
        naming.add(scopeName);
        hasGrown = true;
      }
    }
  }
  return [...naming].sort();
}

mkdirSync(GRAMMAR_DIRECTORY, { recursive: true });
const grammarsByScopeName = await readGrammars();
for (const grammar of grammarsByScopeName.values()) {
  writeFileSync(path.join(GRAMMAR_DIRECTORY, `${grammar.name}.json`), JSON.stringify(grammar));
}
writeFileSync(
  path.join(GRAMMAR_DIRECTORY, "scopes-named-from-text.json"),
  `${JSON.stringify(findScopesNamedFromText(grammarsByScopeName))}\n`,
);
/**
 * A grammar's upstream source and license, from `tm-grammars` at the version `@shikijs/langs` was
 * built from. Throws when neither its record nor `UNRECORDED_GRAMMAR_LICENSES` names a license.
 */
function composeGrammarNotice(grammar) {
  const record = grammarSources.find((source) => source.scopeName === grammar.scopeName);
  if (record === undefined) {
    throw new Error(`tm-grammars has no record of ${grammar.scopeName}`);
  }
  const unrecorded = UNRECORDED_GRAMMAR_LICENSES[record.name];
  const { license, licenseUrl } =
    record.license === undefined && unrecorded?.sha === record.sha ? unrecorded : record;
  if (license === undefined || licenseUrl === undefined) {
    throw new Error(`${record.name} at ${record.sha} names no license to carry`);
  }
  return [
    `${record.displayName} grammar (${grammar.scopeName}, ${license})`,
    `Source: ${record.source}`,
    `License: ${licenseUrl}`,
  ].join("\n");
}

const grammarPackageDirectory = findPackageDirectory(
  fileURLToPath(import.meta.resolve("@shikijs/langs/bash")),
);
const grammarNotices = [...grammarsByScopeName.values()]
  .sort((left, right) => left.scopeName.localeCompare(right.scopeName))
  .map(composeGrammarNotice);
writeFileSync(
  path.join(GRAMMAR_DIRECTORY, "notices.txt"),
  `${[composeNotice(grammarPackageDirectory), ...grammarNotices].join("\n\n---\n\n")}\n`,
);
