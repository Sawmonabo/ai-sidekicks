// Where the background service runs on a Windows computer, and the record that says so. The
// service runs in one place, on Windows itself or inside one WSL 2 distribution, wherever the
// person's Claude Code and Codex are installed. The place must be known before any service
// exists, so it is kept in a per-user Windows file apart from the service's own settings file.
// A backup's manifest names the same place, so a backup made on one side is recognized on the
// other.
import { z } from "zod";

import { ReleaseVersionSchema } from "./release-manifest.js";
import { wireFreeFormString, FILE_PATH_MAX_LEN } from "./free-form-string.js";

/**
 * The record's file name, in `%LOCALAPPDATA%\ai-sidekicks\`.
 *
 * @consumedBy the Windows service start, which writes this record once a start succeeds, and the
 * `sidekicks daemon` commands that read it
 */
export const SERVICE_RECORD_FILE_NAME = "service.json";

/** The longest WSL distribution name accepted. */
export const WSL_DISTRO_NAME_MAX_LEN = 256;

/** A place the service can run on Windows: Windows itself, or a WSL distribution by name. */
export type ServicePlaceLocation = "windows" | { distro: string };

const WslPlaceSchema = z
  .object({ distro: wireFreeFormString(WSL_DISTRO_NAME_MAX_LEN, "distro") })
  .strict();

/** Parses a {@link ServicePlaceLocation}. */
export const ServicePlaceLocationSchema: z.ZodType<ServicePlaceLocation, ServicePlaceLocation> =
  z.union([z.literal("windows"), WslPlaceSchema]);

/** The service runs on Windows itself. */
export interface WindowsServiceRecord {
  place: "windows";
}

/**
 * The service runs inside a WSL distribution, from the runtime the app installed there: the
 * runtime's release version, the SHA-256 of its archive (lowercase hex, which also names its
 * folder), and the distribution's home folder as the install resolved it.
 */
export interface WslServiceRecord {
  place: { distro: string };
  runtimeVersion: string;
  runtimeDigest: string;
  distroHome: string;
}

/** The contents of `service.json`. */
export type ServiceRecord = WindowsServiceRecord | WslServiceRecord;

/**
 * Parses a {@link ServiceRecord}.
 *
 * @consumedBy the Windows service start, which writes this record once a start succeeds, and the
 * `sidekicks daemon` commands that read it
 */
export const ServiceRecordSchema: z.ZodType<ServiceRecord, ServiceRecord> = z.union([
  z.object({ place: z.literal("windows") }).strict(),
  z
    .object({
      place: WslPlaceSchema,
      runtimeVersion: ReleaseVersionSchema,
      runtimeDigest: z
        .string()
        .regex(/^[0-9a-f]{64}$/u, { message: "runtimeDigest is 64 lowercase hex digits." }),
      distroHome: wireFreeFormString(FILE_PATH_MAX_LEN, "ServiceRecord.distroHome"),
    })
    .strict(),
]);
