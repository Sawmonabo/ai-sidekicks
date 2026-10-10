// The third-party notices a packaged app carries, written at build time: every npm package a
// bundle holds, with its license and notice text as the package ships them, and, for a package that
// itself carries other projects' compiled code, the notices and license files it ships for them.
// Each bundle writes its own file under `out/third-party-notices/`, which electron-builder copies
// beside the app's archive.

import { readdirSync, readFileSync, rmSync } from "node:fs";
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

/** A package carrying other projects' code with its own notices for them. */
interface BundledNoticeSource {
  /** The notices file at the package's root. */
  readonly noticesFile: string;
  /** The folder holding each carried project's license files. */
  readonly licensesDirectory: string;
  /** What the package's license obliges a binary to say about where its source is. */
  readonly sourceOffer: (version: string) => string;
}

/**
 * merman ships its compiled ELK, a translation of Eclipse ELK, under EPL-2.0, which asks a program
 * distributed other than as source to say where the source is.
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
};

/** Removes the notices an earlier build wrote, so a bundle that is gone leaves no file to ship. */
export function clearThirdPartyNotices(): void {
  rmSync(THIRD_PARTY_NOTICES_DIRECTORY, { recursive: true, force: true });
}

/** The build plugin that writes `bundleName`'s notices when the bundle is generated. */
export function thirdPartyNoticesPlugin(bundleName: string): ReturnType<typeof license> {
  return license({
    thirdParty: {
      multipleVersions: true,
      output: {
        file: path.join(THIRD_PARTY_NOTICES_DIRECTORY, `${bundleName}.txt`),
        template: (dependencies) =>
          [...dependencies]
            .sort((left, right) => (left.name ?? "").localeCompare(right.name ?? ""))
            .map(noticeOf)
            .join(`\n\n${"=".repeat(80)}\n\n`),
      },
    },
  });
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
    bundled.sourceOffer(version),
    readFileSync(path.join(packageDirectory, bundled.noticesFile), "utf8"),
    ...licenseFiles.map(
      (file) =>
        `--- ${path.relative(packageDirectory, file).split(path.sep).join("/")} ---\n\n` +
        readFileSync(file, "utf8"),
    ),
  ];
}
