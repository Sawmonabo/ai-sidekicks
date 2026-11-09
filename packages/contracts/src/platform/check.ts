// The check a daemon or the desktop app runs on its own process at start: a build runs only on the
// operating systems it is made for.
import { SUPPORTED_PLATFORMS, type SupportedPlatform } from "../generated/platform.js";

/** `platform`, in Node's spelling, as a supported one. Throws a `RangeError` for any other. */
export function supportedPlatform(platform: string): SupportedPlatform {
  const supported = SUPPORTED_PLATFORMS.find((candidate) => candidate === platform);
  if (supported === undefined) {
    throw new RangeError(`This build does not run on the ${platform} platform.`);
  }
  return supported;
}
