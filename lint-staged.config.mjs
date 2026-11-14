// ESLint and Prettier skip a staged file their ignore lists name, which holds every file of the
// packages the Rust port deletes; ESLint would warn about each one, so the warning is off.
// rustfmt and Tombi read no ignore list, so rustfmt is handed only the crates' Rust files and
// Tombi every TOML file outside those packages.

import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";

/** The line in `.prettierignore` heading the folders of the packages the Rust port deletes. */
const DELETED_PACKAGES_HEADING = "# The packages the Rust port deletes";

/**
 * The folders whose TOML files Tombi is not handed: the packages the Rust port deletes, read from
 * the lines under their heading in `.prettierignore` up to a blank line, a comment or the file's
 * end, so the list is kept once. Throws when the heading is gone.
 */
function readTombiSkippedFolders() {
  const lines = readFileSync(new URL(".prettierignore", import.meta.url), "utf8").split("\n");
  const heading = lines.findIndex((line) => line.startsWith(DELETED_PACKAGES_HEADING));
  if (heading === -1) {
    throw new Error(`.prettierignore has no line starting "${DELETED_PACKAGES_HEADING}"`);
  }
  const folders = [];
  for (const line of lines.slice(heading + 1)) {
    const folder = line.trim();
    if (folder === "" || folder.startsWith("#")) break;
    folders.push(folder);
  }
  return folders;
}

const TOMBI_SKIPPED_FOLDERS = readTombiSkippedFolders();

/** @type {import("lint-staged").Configuration} */
export default {
  "*.{ts,tsx,mts,cts}": ["eslint --fix --cache --no-warn-ignored", "prettier --write"],
  "*.{js,mjs,cjs,jsx}": ["eslint --fix --cache --no-warn-ignored", "prettier --write"],
  "*.{json,json5,md,yml,yaml,css,scss}": ["prettier --write"],
  "crates/**/*.rs": ["rustfmt"],
  "*.toml": (stagedFiles) => {
    // A path compared with `/` between its folders, as `.prettierignore` writes them.
    const keptFiles = stagedFiles.filter((file) => {
      const path = relative(".", file).split(sep).join("/");
      return !TOMBI_SKIPPED_FOLDERS.some((folder) => path.startsWith(folder));
    });
    return keptFiles.length === 0
      ? []
      : [`tombi format ${keptFiles.map((file) => JSON.stringify(file)).join(" ")}`];
  },
};
