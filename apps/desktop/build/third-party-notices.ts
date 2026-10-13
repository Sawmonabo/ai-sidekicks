// The third-party notices a packaged app carries, written at build time: every npm package a
// bundle holds, with its license and notice text as the package ships them, and, for a package that
// itself carries other projects' compiled code, the notices and license files it ships for them.
// The workspace's own packages are the app's own code and are left out, unless one carries other
// projects' compiled code. Each bundle writes its own file under `out/third-party-notices/`, which
// electron-builder copies beside the app's archive.

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Dependency } from "rollup-plugin-license";

/** The plugin's factory: its package exports the CommonJS module itself, typed as `default`. */
const license = createRequire(import.meta.url)(
  "rollup-plugin-license",
) as typeof import("rollup-plugin-license").default;

/** Where the notices are written; electron-builder ships the folder beside the archive. */
const THIRD_PARTY_NOTICES_DIRECTORY = fileURLToPath(
  new URL("../out/third-party-notices/", import.meta.url),
);

/** The desktop package's own dependencies, where a direct dependency's files are found. */
const PACKAGE_MODULES_DIRECTORY = fileURLToPath(new URL("../node_modules/", import.meta.url));

/** The scope of the workspace's own packages, the app's own code rather than a third party's. */
const WORKSPACE_PACKAGE_SCOPE = "@ai-sidekicks/";

/** A package carrying other projects' code with its own notices for them. */
interface BundledNoticeSource {
  /** The notices file, by its path in the package. */
  readonly noticesFile: string;
  /** The folder holding each carried project's license files, by its path in the package. */
  readonly licensesDirectory: string;
  /** What a carried project's license obliges a binary to say about where its source is, if any. */
  readonly sourceOffer?: (version: string) => string;
}

/**
 * merman ships its compiled ELK, a translation of Eclipse ELK, under EPL-2.0, which asks a program
 * distributed other than as source to say where the source is. The compression module carries
 * compiled Rust crates, whose licenses ask only that their notices travel with it.
 */
const BUNDLED_NOTICE_SOURCES: Readonly<Record<string, BundledNoticeSource>> = {
  "@mermanjs/web-render": {
    noticesFile: "THIRD_PARTY_NOTICES.md",
    licensesDirectory: "THIRD_PARTY_LICENSES",
    sourceOffer: (version) =>
      `The compiled ELK in this package (merman-elk-layered, a Rust translation of Eclipse ELK) ` +
      `is distributed under the Eclipse Public License 2.0 (EPL-2.0). Its source code is ` +
      `available at https://github.com/Latias94/merman/tree/v${version}.`,
  },
  "@ai-sidekicks/compression": {
    noticesFile: "dist/THIRD_PARTY_NOTICES.md",
    licensesDirectory: "dist/THIRD_PARTY_LICENSES",
  },
};

/** Removes the notices an earlier build wrote, so a bundle that is gone leaves no file to ship. */
export function clearThirdPartyNotices(): void {
  rmSync(THIRD_PARTY_NOTICES_DIRECTORY, { recursive: true, force: true });
}

/** A plugin as the bundler takes it. */
type BuildPlugin = ReturnType<typeof license>;

/**
 * The build plugins that write one bundle's notices to `<name>.txt` when the bundle is generated,
 * the name given by `nameBundle` for the bundle's one entry module as the build starts. A worker's
 * plugins are made afresh for each worker, so each worker names and writes its own file. Throws
 * when the bundle has other than one entry, or when `nameBundle` does.
 */
export function thirdPartyNoticesPlugins(
  nameBundle: (entryModuleId: string) => string,
): BuildPlugin[] {
  let bundleName: string | undefined;
  const naming: BuildPlugin = {
    name: "third-party-notices-bundle-name",
    buildStart(options) {
      const entries = Object.values(options.input);
      const [entry] = entries;
      if (entry === undefined || entries.length !== 1) {
        throw new Error(`a bundle's notices need one entry, and it has ${String(entries.length)}`);
      }
      bundleName = nameBundle(entry);
    },
  };
  const notices = license({
    thirdParty: {
      multipleVersions: true,
      // Some of the workspace's own packages are private; every package comes through, and the
      // workspace's own are filtered out below.
      includePrivate: true,
      output: (dependencies) => {
        if (bundleName === undefined) {
          throw new Error("the notices were generated before the bundle was named");
        }
        const thirdParty = dependencies.filter((dependency) => {
          const name = dependency.name ?? "";
          return (
            !name.startsWith(WORKSPACE_PACKAGE_SCOPE) || BUNDLED_NOTICE_SOURCES[name] !== undefined
          );
        });
        mkdirSync(THIRD_PARTY_NOTICES_DIRECTORY, { recursive: true });
        writeFileSync(
          path.join(THIRD_PARTY_NOTICES_DIRECTORY, `${bundleName}.txt`),
          thirdParty.length === 0
            ? "This bundle carries no third-party package.\n"
            : thirdParty
                .sort((left, right) => (left.name ?? "").localeCompare(right.name ?? ""))
                .map(noticeOf)
                .join(`\n\n${"=".repeat(80)}\n\n`),
        );
      },
    },
  });
  return [naming, notices];
}

function noticeOf(dependency: Dependency): string {
  const name = dependency.name ?? "(unnamed package)";
  const version = dependency.version ?? "";
  const sections = [
    `${name} ${version}`.trim(),
    `License: ${dependency.license ?? "not declared"}`,
    dependency.licenseText ?? "",
    dependency.noticeText ?? "",
  ];
  const bundled = BUNDLED_NOTICE_SOURCES[name];
  if (bundled !== undefined) {
    sections.push(...bundledNoticesOf(name, version, bundled));
  }
  return sections.filter((section) => section !== "").join("\n\n");
}

/** A carrying package's notices, then every license file it ships, by its path in the package. */
function bundledNoticesOf(name: string, version: string, bundled: BundledNoticeSource): string[] {
  const packageDirectory = path.join(PACKAGE_MODULES_DIRECTORY, name);
  const licensesDirectory = path.join(packageDirectory, bundled.licensesDirectory);
  const licenseFiles = readdirSync(licensesDirectory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
  return [
    ...(bundled.sourceOffer === undefined ? [] : [bundled.sourceOffer(version)]),
    readFileSync(path.join(packageDirectory, bundled.noticesFile), "utf8"),
    ...licenseFiles.map(
      (file) =>
        `--- ${path.relative(packageDirectory, file).split(path.sep).join("/")} ---\n\n` +
        readFileSync(file, "utf8"),
    ),
  ];
}
