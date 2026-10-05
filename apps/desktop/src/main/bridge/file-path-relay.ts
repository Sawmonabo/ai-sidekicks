// Main's relay between the page's file tokens and the paths the daemon reads. A verb that acts on
// a picked, dropped or pasted file takes the file's token from the page, and main puts the path
// the token stands for in its place on the way to the daemon; anything else in that member, a raw
// path above all, is refused before anything is sent. A reply that offers a path to open has a
// token minted for each such path, which `native.openInEditor` and `native.revealInFileExplorer`
// take, so the page shows a path as text and never holds one as a capability.
//
// Where each verb carries a path is named here once, by the contract's member names: a member is
// a key, and `*` is each element of a list.

import type { FilePathRef } from "@shared/preload-api.js";

import type { FilePathRefOwner, FilePathRefs } from "./file-path-refs.js";

/** Where one path sits in a request or a reply: keys from the root, `*` for each list element. */
type PathLocation = readonly string[];

/** The request members that hold a file the person picked, dropped or pasted, by verb. */
const REQUEST_PATH_LOCATIONS: ReadonlyMap<string, readonly PathLocation[]> = new Map([
  ["session.attachmentAdd", [["items", "*", "path"]]],
  ["workflow.definitionExport", [["filePath"]]],
  ["workflow.definitionImport", [["filePath"]]],
  ["agent.definitionExport", [["folder"]]],
  ["agent.definitionImport", [["folder"]]],
  ["agent.definitionUpdate", [["reattachFilePath"]]],
]);

/** The reply members that hold a path the page offers to open, by verb. */
const REPLY_PATH_LOCATIONS: ReadonlyMap<string, readonly PathLocation[]> = new Map([
  ["session.memoryRead", [["entries", "*", "path"]]],
  [
    "session.hookList",
    [
      ["files", "*", "path"],
      ["folders", "*", "hooks", "*", "sourcePath"],
    ],
  ],
]);

/**
 * `params` with each token `method` takes in place of a path swapped for the path, for a page
 * that holds those tokens. A member absent from `params` is left for the contract to judge. Throws
 * a `TypeError` for a value in a path member that is not a token `owner` holds, a raw path
 * included.
 */
export function swapTokensForPaths(
  filePathRefs: FilePathRefs,
  owner: FilePathRefOwner,
  method: string,
  params: unknown,
): unknown {
  let swapped = params;
  for (const location of REQUEST_PATH_LOCATIONS.get(method) ?? []) {
    swapped = replaceAt(swapped, location, (ref) => filePathRefs.requirePath(owner, ref));
  }
  return swapped;
}

/**
 * A token for each path `method`'s reply `value` offers to open, minted for `owner` and keyed by
 * the path, so the page opens what it shows. Empty for a verb whose reply offers none.
 */
export function mintTokensForPaths(
  filePathRefs: FilePathRefs,
  owner: FilePathRefOwner,
  method: string,
  value: unknown,
): Readonly<Record<string, FilePathRef>> {
  const refs: Record<string, FilePathRef> = {};
  for (const location of REPLY_PATH_LOCATIONS.get(method) ?? []) {
    replaceAt(value, location, (path) => {
      if (typeof path === "string") {
        refs[path] ??= filePathRefs.mint(owner, path);
      }
      return path;
    });
  }
  return refs;
}

/** `value` with what sits at `location` replaced by `replace`'s answer; a copy where it changed. */
function replaceAt(
  value: unknown,
  location: PathLocation,
  replace: (found: unknown) => unknown,
): unknown {
  const [key, ...rest] = location;
  if (key === undefined) {
    return replace(value);
  }
  if (key === "*") {
    return Array.isArray(value) ? value.map((element) => replaceAt(element, rest, replace)) : value;
  }
  // An optional member left out, or sent as `undefined`, holds nothing to swap.
  if (!isRecord(value) || value[key] === undefined) {
    return value;
  }
  return { ...value, [key]: replaceAt(value[key], rest, replace) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
