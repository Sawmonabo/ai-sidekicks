// The operating systems a build runs on, in Node's spelling, which the daemon and the desktop app
// each check their own process against at start.

/** The operating systems a build runs on. */
export const SUPPORTED_PLATFORMS = ["darwin", "linux", "win32"] as const;

/** One supported operating system, in Node's spelling. */
export type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number];

/** `platform` as a supported one. Throws a `RangeError` for any other. */
export function supportedPlatform(platform: string): SupportedPlatform {
  const supported = SUPPORTED_PLATFORMS.find((candidate) => candidate === platform);
  if (supported === undefined) {
    throw new RangeError(`This build does not run on the ${platform} platform.`);
  }
  return supported;
}
