// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Where work runs on a computer: Windows itself, or a WSL 2 distribution by name.

/** The longest WSL distribution name accepted. */
export const WSL_DISTRO_NAME_MAX_LEN = 256 as const;

/**
 * A WSL distribution's name: not blank, no NUL, and at most `WSL_DISTRO_NAME_MAX_LEN` code
 * points.
 */
export type DistroName = string & { readonly __brand: "DistroName" };
/**
 * Where work runs: `"windows"`, or `{distro}` for a WSL 2 distribution. A provider's `Command`
 * row may also name a WSL 1 distribution, the one place no work runs.
 */
export type Place = "windows" | WslPlace;

/**
 * A WSL distribution, named exactly as `wsl -l` prints it. Work runs only in a WSL 2
 * distribution; a WSL 1 one appears only as a provider's `Command` row that says it needs WSL 2.
 */
export interface WslPlace {
  /**
   * The distribution's name.
   */
  distro: DistroName;
}
/**
 * A path, and the WSL 2 distribution it is in where it is in Linux form there; the place is absent
 * wherever the path's own form says it.
 */
export interface PlacedPath {
  /**
   * The path.
   */
  path: string;
  /**
   * The distribution.
   */
  place?: WslPlace;
}
/**
 * The details of a refusal naming a WSL distribution, a repository's or a provider's: the
 * distribution the request names, exactly as given.
 */
export interface DistributionRefusalDetails {
  /**
   * The distribution.
   */
  distro: DistroName;
}
