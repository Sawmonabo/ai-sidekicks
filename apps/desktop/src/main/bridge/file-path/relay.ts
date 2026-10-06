// Main's relay between the page's file tokens and the paths the daemon reads. A verb that acts on
// a picked, dropped or pasted file takes the file's token from the page, and main puts the path
// the token stands for in its place on the way to the daemon; anything else in that member, a raw
// path above all, is refused before anything is sent. A reply that offers a path to open has a
// token minted for each such path, which `native.openInEditor` and `native.revealInFileExplorer`
// take, so the page shows a path as text and never holds one as a capability.
//
// Where each verb carries a path is named here once, by the contract's member names: a member is
// a key, and `*` is each element of a list. Only verbs the app calls are named, since `call()`
// refuses every other before the relay runs.

import nodePath from "node:path";

import type { FilePathRef } from "#shared/preload-api.js";

import { isPlainObject } from "../../services/plain-object.js";

import type { FilePathPurpose, FilePathRefOwner, FilePathRefs } from "./refs.js";

/** Where one path sits in a request or a reply: keys from the root, `*` for each list element. */
type PathLocation = readonly string[];

/** One request member that holds a file, and the purpose its token must have been minted for. */
interface RequestPathMember {
  readonly location: PathLocation;
  readonly purpose: FilePathPurpose;
}

/** The verb that stages files for the next message, which the service copies into its store. */
const ATTACHMENT_ADD_METHOD = "session.attachmentAdd";

/**
 * The request members that hold a file or folder the person picked, dropped or pasted, by verb.
 * The import and export verbs join it as the app calls them.
 */
const REQUEST_PATH_MEMBERS: ReadonlyMap<string, readonly RequestPathMember[]> = new Map([
  // A human form's `path` field, answered with a folder picked by the platform's chooser.
  ["workflow.humanFormSubmit", [{ location: ["paths", "*", "path"], purpose: "folder" }]],
  // A staged file: picked, dropped or pasted into the composer.
  [ATTACHMENT_ADD_METHOD, [{ location: ["items", "*", "path"], purpose: "attach" }]],
]);

/** The reply members that hold a path the page offers to open, by verb. */
const REPLY_PATH_LOCATIONS: ReadonlyMap<string, readonly PathLocation[]> = new Map([
  ["session.memoryRead", [["entries", "*", "path"]]],
]);

/**
 * `params` with each token `method` takes in place of a path swapped for the path, for a page
 * that holds those tokens. A member absent from `params` is left for the contract to judge. Throws
 * a `TypeError` for a value in a path member that is not a token `owner` holds for that member's
 * purpose, a raw path included.
 */
export function swapTokensForPaths(
  filePathRefs: FilePathRefs,
  owner: FilePathRefOwner,
  method: string,
  params: unknown,
): unknown {
  let swapped = params;
  for (const { location, purpose } of REQUEST_PATH_MEMBERS.get(method) ?? []) {
    swapped = replaceAt(swapped, location, (ref) => filePathRefs.requirePath(owner, ref, purpose));
  }
  return swapped;
}

/**
 * A token to open each absolute path `method`'s reply `value` offers, minted for `owner` and keyed
 * by the path, so the page opens what it shows. A path that is not absolute is shown and never
 * opened: a program handed one could read it as an option. Empty for a verb whose reply offers
 * none.
 */
export function mintTokensForPaths(
  filePathRefs: FilePathRefs,
  owner: FilePathRefOwner,
  method: string,
  value: unknown,
): Readonly<Record<string, FilePathRef>> {
  const refsByPath = new Map<string, FilePathRef>();
  for (const location of REPLY_PATH_LOCATIONS.get(method) ?? []) {
    for (const path of valuesAt(value, location)) {
      if (typeof path === "string" && isAbsolutePath(path) && !refsByPath.has(path)) {
        refsByPath.set(path, filePathRefs.mint(owner, "open", path));
      }
    }
  }
  return Object.fromEntries(refsByPath);
}

/**
 * The paths whose files a served `method` reply says the service copied into its store, read off
 * the params `sent` with paths in place of tokens: for the staging verb, each file item the reply
 * does not refuse. Empty for every other verb.
 */
export function copiedFilePaths(method: string, sent: unknown, value: unknown): readonly string[] {
  if (method !== ATTACHMENT_ADD_METHOD) {
    return [];
  }
  const refusedIds = new Set(valuesAt(value, ["refused", "*", "clientStagingId"]));
  const copied: string[] = [];
  for (const item of valuesAt(sent, ["items", "*"])) {
    if (
      isPlainObject(item) &&
      item["kind"] === "file" &&
      typeof item["path"] === "string" &&
      !refusedIds.has(item["clientStagingId"])
    ) {
      copied.push(item["path"]);
    }
  }
  return copied;
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
  if (!isPlainObject(value) || value[key] === undefined) {
    return value;
  }
  return { ...value, [key]: replaceAt(value[key], rest, replace) };
}

/** Every value at `location` in `value`, read in place. */
function* valuesAt(value: unknown, location: PathLocation): Generator<unknown> {
  const [key, ...rest] = location;
  if (key === undefined) {
    yield value;
    return;
  }
  if (key === "*") {
    if (Array.isArray(value)) {
      for (const element of value) {
        yield* valuesAt(element, rest);
      }
    }
    return;
  }
  if (isPlainObject(value) && Object.hasOwn(value, key)) {
    yield* valuesAt(value[key], rest);
  }
}

// The daemon answers with paths on its own machine, a POSIX one or, on Windows, a Windows one.
function isAbsolutePath(path: string): boolean {
  return nodePath.posix.isAbsolute(path) || nodePath.win32.isAbsolute(path);
}
