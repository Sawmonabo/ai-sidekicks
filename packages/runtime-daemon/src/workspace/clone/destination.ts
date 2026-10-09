// Where a clone goes and whether it may: the repository's name as git reads it from the address,
// the folder that name makes inside the clone folder, and whether that folder is free to clone
// into. Two addresses are compared by the repository they name, whatever transport reaches it, and
// an address is kept with no user or password in it. Git clones into a folder the daemon makes
// beside the destination and knows by its device and inode, which alone a failure removes, and a
// finished clone is renamed into place.

import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm, rmdir } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// `git@github.com:team/app.git`: a user and host, a colon, then a path that is not `//`.
const SCP_LIKE_ADDRESS = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/;

// A Windows drive path, `C:\work\app` or `C:/work/app`, which the address form above would match.
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;

/**
 * The repository's name as `git clone` reads it from the address: the last path part with any
 * trailing slash, `/.git` and `.git` dropped (`https://host/team/app.git` reads `app`), or `null`
 * when the address leaves no name, which no clone may use as a folder.
 */
export function repositoryNameOf(url: string): string | null {
  let rest = url.trim().replace(/[\\/]+$/, "");
  rest = rest.replace(/[\\/]\.git$/, "").replace(/[\\/]+$/, "");
  const name = rest
    .slice(Math.max(rest.lastIndexOf("/"), rest.lastIndexOf("\\"), rest.lastIndexOf(":")) + 1)
    .replace(/\.git$/, "");
  return name === "" || name === "." || name === ".." ? null : name;
}

/**
 * The repository an address names, for comparing two addresses: host and path for a network
 * address, whatever its transport and user (`git@host:team/app` and `https://host/team/app.git`
 * name one repository), and the absolute path for a local one or an address no rule reads.
 */
export function repositoryKeyOf(url: string): string {
  const address = url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  const scpLike = WINDOWS_DRIVE_PATH.test(address) ? null : SCP_LIKE_ADDRESS.exec(address);
  if (scpLike !== null) {
    const [, host = "", repositoryPath = ""] = scpLike;
    return `${host.toLowerCase()}/${repositoryPath.replace(/^\/+/, "")}`;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(address) && URL.canParse(address)) {
    const parsed = new URL(address);
    if (parsed.protocol === "file:") return path.resolve(fileURLToPath(parsed));
    const port = parsed.port === "" ? "" : `:${parsed.port}`;
    return `${parsed.hostname.toLowerCase()}${port}${parsed.pathname}`;
  }
  return path.resolve(address);
}

// A network address's scheme and `//`, then the user and password before the host's `@`.
const ADDRESS_CREDENTIALS = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i;

/**
 * The address with any user and password taken out (`https://ana:token@host/app.git` reads
 * `https://host/app.git`), for keeping it; git still runs with the address as typed.
 */
export function addressWithoutCredentials(url: string): string {
  return url.replace(ADDRESS_CREDENTIALS, "$1");
}

/** A clone destination as it stands: not there, an empty folder, or holding something. */
export type DestinationState = "missing" | "empty" | "taken";

/**
 * Reads whether `folder` is free to clone into: missing, or an empty folder. Throws what the read
 * throws for anything but a missing folder, a file in its place included.
 */
export async function readDestinationState(folder: string): Promise<DestinationState> {
  try {
    return (await readdir(folder)).length === 0 ? "empty" : "taken";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

/** The folder the daemon made for a clone to run in, known by its device and inode. */
export interface StagedClone {
  readonly path: string;
  /** `<device>:<inode>` as the folder's own stat read it when it was made. */
  readonly identity: string;
}

// Random bytes in a staged clone's folder name, so two clones of one name never meet.
const STAGED_CLONE_SUFFIX_BYTES = 6;

/**
 * Makes the folder git clones into, hidden beside `destination` in its parent (made when missing),
 * by a `mkdir` that fails if the folder exists, so the folder answered is one this call made.
 */
export async function makeStagedClone(destination: string): Promise<StagedClone> {
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true });
  const suffix = randomBytes(STAGED_CLONE_SUFFIX_BYTES).toString("hex");
  const folder = path.join(parent, `.${path.basename(destination)}.clone-${suffix}`);
  await mkdir(folder);
  const identity = await readFolderIdentity(folder);
  if (identity === null) throw new Error("the clone's folder was replaced as it was made");
  return { path: folder, identity };
}

/**
 * Removes a staged clone's folder only while the path still holds that same folder; a path gone,
 * or holding anything else, is left as it is.
 */
export async function removeStagedClone(folder: StagedClone): Promise<void> {
  let identity: string | null;
  try {
    identity = await readFolderIdentity(folder.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (identity !== folder.identity) return;
  await rm(folder.path, { recursive: true, force: true });
}

/**
 * Renames a finished staged clone's folder to `destination`, first removing an empty folder there,
 * and answers it at its new path. Answers `null`, moving nothing, when the destination holds
 * anything.
 */
export async function moveStagedCloneIntoPlace(
  folder: StagedClone,
  destination: string,
): Promise<StagedClone | null> {
  try {
    // `rmdir` removes only an empty folder, so a folder that filled is refused, not emptied.
    await rmdir(destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOTDIR") return null;
    if (code !== "ENOENT") throw error;
  }
  try {
    await rename(folder.path, destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOTDIR") return null;
    throw error;
  }
  return { path: destination, identity: folder.identity };
}

// `<device>:<inode>` of a folder; anything else at the path reads no identity a folder can match.
async function readFolderIdentity(folder: string): Promise<string | null> {
  // Big integers, since an inode can pass what a double holds exactly.
  const stats = await lstat(folder, { bigint: true });
  return stats.isDirectory() ? `${String(stats.dev)}:${String(stats.ino)}` : null;
}
