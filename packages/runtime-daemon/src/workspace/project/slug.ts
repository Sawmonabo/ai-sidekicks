// A project's slug: the name of its worktrees folder, `<worktrees>/<slug>/`, fixed at attach so a
// rename moves no worktree. Made from the folder's own name, safe on every filesystem: lowercase,
// so two projects never differ by case alone on a case-insensitive disk, never starting with a
// dot, which names the kept-worktrees folder beside it, never a device name Windows reserves, and
// unique among the projects and the folders already there.

// What a slug keeps: letters, digits, `.`, `_` and `-`; any other run becomes one `-`.
const UNSAFE_SLUG_RUN = /[^a-z0-9._-]+/g;

// Leading dots and dashes, and trailing dots, dashes and spaces: Windows refuses a folder name
// ending in a dot or a space, and a leading dash reads as an option.
const UNSAFE_SLUG_EDGES = /^[.-]+|[.\s-]+$/g;

// The file system's 255-byte limit on one folder name (NAME_MAX on APFS and ext4). A slug holds
// only ASCII, so each character is one byte and every cut falls on a whole code point.
const SLUG_MAX_LENGTH = 255;

// The slug of a folder whose name keeps no safe character.
const FALLBACK_SLUG = "project";

// The device names Windows reserves in every folder, alone or before a first dot (`con`, `nul.d`).
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/;

/** The slug a folder named `folderName` starts from, before it is made unique. */
export function slugBaseOf(folderName: string): string {
  const base = folderName
    .normalize("NFKD")
    .toLowerCase()
    .replace(UNSAFE_SLUG_RUN, "-")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(UNSAFE_SLUG_EDGES, "");
  if (base === "") return FALLBACK_SLUG;
  // Windows opens the device for such a name, never a folder, so the fallback goes in front.
  return WINDOWS_RESERVED_NAME.test(base)
    ? `${FALLBACK_SLUG}-${base}`.slice(0, SLUG_MAX_LENGTH).replace(UNSAFE_SLUG_EDGES, "")
    : base;
}

/**
 * The `ordinal`th candidate for `base`: the base itself first, then `base-2`, `base-3`, …, the base
 * cut so the suffix still fits the slug's length.
 */
export function slugCandidate(base: string, ordinal: number): string {
  if (ordinal === 1) return base;
  const suffix = `-${String(ordinal)}`;
  return `${base.slice(0, SLUG_MAX_LENGTH - suffix.length)}${suffix}`;
}
