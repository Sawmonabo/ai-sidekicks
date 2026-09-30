/**
 * What a snapshot capture needs besides the service: the commit's message, trailers and identity,
 * the listings it reads from the index, and the fingerprints that name each path's content.
 */

import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, readFile, readlink } from "node:fs/promises";

/**
 * The same bytes for every snapshot: the message is an OID input, so identity content would make
 * identical state hash differently. Trailers derived from project state keep that property.
 */
export const SNAPSHOT_COMMIT_MESSAGE = "sidekicks: turn-boundary snapshot";

/**
 * Names the embedded repositories the capture could not record. A skipped one is absent from the
 * tree, so a restore would delete it and its `.git` as untracked. Written only when non-empty,
 * JSON-encoded (a newline cannot forge a trailer) and sorted (message bytes are an OID input).
 */
export const SKIPPED_EMBEDDED_REPOSITORIES_TRAILER = "Skipped-Embedded-Repositories:";

/**
 * Names out-of-cone paths at the boundary that the tree lacks (untracked, or intent-to-add:
 * `write-tree` omits them, git 2.50.1); a restore would delete them. Written in every sparse root
 * (`[]` when empty), so presence is the format marker. JSON, sorted, latin1 (see {@link
 * listingEntryKey}). A trailing slash marks a directory git did not descend into (a restore
 * exempts everything beneath it).
 */
export const SPARSE_BOUNDARY_PATHS_TRAILER = "Sparse-Boundary-Paths:";

/**
 * An explicit identity: without one `commit-tree` fails in a container with no passwd entry, and
 * elsewhere stamps the OS user.
 */
export const SNAPSHOT_IDENTITY_NAME = "AI Sidekicks";

/** The committer email that goes with the snapshot identity name. */
export const SNAPSHOT_IDENTITY_EMAIL = "snapshots@ai-sidekicks.invalid";

// Hex length per `rev-parse --show-object-format` name. A valid id can be un-insertable in a
// repository of the other width (see `#normalizeEmbeddedRepositories`); an unknown name throws.
const OBJECT_ID_HEX_LENGTHS: ReadonlyMap<string, number> = new Map<string, number>([
  ["sha1", 40],
  ["sha256", 64],
]);

/** The tree mode git gives an embedded repository entry. */
export const GITLINK_TREE_MODE = "160000";

/**
 * The listing's only exclude source: porcelain `add -A` also honors `core.excludesFile` and
 * `$GIT_DIR/info/exclude`, which are not project declarations.
 */
export const EXCLUDE_PER_DIRECTORY_GITIGNORE = "--exclude-per-directory=.gitignore";

const NUL_TERMINATOR: Buffer = Buffer.from([0]);

/** The config key that turns sparse checkout on. */
export const CORE_SPARSE_CHECKOUT_KEY = "core.sparseCheckout";

/**
 * The lock is held for one index write, so contention clears at once. A stale lock from a crashed
 * git must fail fast as a typed error; this code never removes a lock it did not create.
 */
export const SPARSE_SEED_INDEX_LOCK_ATTEMPTS = 4;

/** Milliseconds to wait between the lock attempts. */
export const SPARSE_SEED_INDEX_LOCK_RETRY_DELAY_MS = 25;

/**
 * An ISO instant as git's raw `<unix-seconds> +0000` date; the fixed offset keeps the snapshot id
 * independent of the host timezone. `null` for an unparseable clock.
 */
export function toRawGitDate(isoInstant: string): string | null {
  const milliseconds: number = Date.parse(isoInstant);
  if (!Number.isFinite(milliseconds)) {
    return null;
  }
  return `${String(Math.floor(milliseconds / 1000))} +0000`;
}

/**
 * Decoded paths, used only to classify trailing-slash entries; comparisons against the boundary
 * set use {@link splitNulTerminatedListingBytes} and {@link listingEntryKey}.
 */
export function splitNulTerminatedListing(listing: Buffer): readonly string[] {
  const entries: string[] = [];
  let start = 0;
  for (let index = 0; index < listing.length; index += 1) {
    if (listing[index] === 0) {
      if (index > start) {
        entries.push(listing.toString("utf8", start, index));
      }
      start = index + 1;
    }
  }
  // Not a shape git produces, but dropping a trailing path would silently omit it.
  if (start < listing.length) {
    entries.push(listing.toString("utf8", start));
  }
  return entries;
}

/** Undecoded {@link splitNulTerminatedListing}: a decode would break the match with git's echo. */
export function splitNulTerminatedListingBytes(listing: Buffer): readonly Buffer[] {
  const entries: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < listing.length; index += 1) {
    if (listing[index] === 0) {
      if (index > start) {
        entries.push(listing.subarray(start, index));
      }
      start = index + 1;
    }
  }
  if (start < listing.length) {
    entries.push(listing.subarray(start));
  }
  return entries;
}

/** Joins entries into one NUL-terminated listing, the inverse of splitting one. */
export function joinNulTerminatedListing(entries: readonly Buffer[]): Buffer {
  if (entries.length === 0) {
    return Buffer.alloc(0);
  }
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(entry, NUL_TERMINATOR);
  }
  return Buffer.concat(parts);
}

/** A byte-exact map key: `latin1` maps bytes one-to-one; `utf8` would merge invalid sequences. */
export function listingEntryKey(entry: Buffer): string {
  return entry.toString("latin1");
}

/** The object-id hex length for a `--show-object-format` name; throws on an unknown one. */
export function requireObjectIdHexLength(stdout: Buffer): number {
  const format: string = stdout.toString("utf8").trim();
  const hexLength: number | undefined = OBJECT_ID_HEX_LENGTHS.get(format);
  if (hexLength === undefined) {
    throw new Error(`git reported an unrecognized object format: ${format}`);
  }
  return hexLength;
}

/**
 * A type-aware fingerprint of the entry at `path` (`absent`, `directory`, `other`,
 * `file:<sha256>`, `symlink:<sha256 of target>`, or `...:unreadable`), so equal fingerprints mean
 * the same kind and content. Uses `lstat` and no git; directories carry no hash; an `lstat`
 * failure reads `absent`.
 *
 * @consumedBy the turn checkpointer
 */
export async function fingerprintPath(path: string): Promise<string> {
  let entry: Stats;
  try {
    entry = await lstat(path);
  } catch {
    return "absent";
  }
  if (entry.isSymbolicLink()) {
    try {
      return `symlink:${hashBytes(Buffer.from(await readlink(path), "utf8"))}`;
    } catch {
      return "symlink:unreadable";
    }
  }
  if (entry.isDirectory()) {
    return "directory";
  }
  if (!entry.isFile()) {
    return "other";
  }
  try {
    return `file:${hashBytes(await readFile(path))}`;
  } catch {
    return "file:unreadable";
  }
}

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The cone partition of one `-z` listing. `outOfConeEntries` stay undecoded byte slices (trailing
 * slash kept) because the boundary subtraction compares them against another git listing.
 */
export interface SparseListingPartition {
  readonly inConeListing: Buffer;
  readonly outOfConeEntries: readonly Buffer[];
}
