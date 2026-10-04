/**
 * Finds the Rust PTY sidecar executable: an explicit override, the published per-platform package,
 * or the workspace build output.
 */

import { existsSync as fsExistsSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute as pathIsAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PTY_BACKEND_UNAVAILABLE_CODE,
  type PtyBackendUnavailableDetails,
} from "@ai-sidekicks/contracts/error";

/**
 * Thrown when no PTY backend is usable (binary missing, crash budget exhausted). `details` is the
 * wire payload from `@ai-sidekicks/contracts`.
 */
export class PtyBackendUnavailableError extends Error {
  public readonly code: typeof PTY_BACKEND_UNAVAILABLE_CODE = PTY_BACKEND_UNAVAILABLE_CODE;

  public readonly details: PtyBackendUnavailableDetails;

  public constructor(details: PtyBackendUnavailableDetails, message: string) {
    super(message);
    this.name = "PtyBackendUnavailableError";
    this.details = details;
  }
}

/** Injectable overrides for `resolveSidecarBinaryPath`; production passes none of them. */
export interface ResolveSidecarBinaryPathOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly nodeRequire?: { resolve: (id: string) => string };
  readonly existsSync?: (path: string) => boolean;
  /** Path probed by step 3 instead of the workspace release build. */
  readonly releasePath?: string;
  /** Path probed by step 4 instead of the workspace debug build. */
  readonly debugPath?: string;
  readonly platform?: NodeJS.Platform;
}

/** One step's outcome, listed in the error message when every step fails. */
interface ResolutionAttempt {
  readonly step: 1 | 2 | 3 | 4;
  readonly description: string;
  readonly outcome: string;
}

/** Module id of the published platform package's binary (step 2); `binaryName` has any `.exe`. */
function publishedPackageIdFor(
  platform: NodeJS.Platform,
  arch: string,
  binaryName: string,
): string {
  return `@ai-sidekicks/pty-sidecar-${platform}-${arch}/bin/${binaryName}`;
}

function platformBinaryName(base: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? `${base}.exe` : base;
}

/** Workspace build path for step 3 or 4, resolved from this file's URL. */
function workspaceTargetPath(profile: "release" | "debug", binaryName: string): string {
  // Three levels up from `{src,dist}/pty/` is `packages/`; located from this file's URL, never cwd.
  const url: URL = new URL(
    `../../../sidecar-rust-pty/target/${profile}/${binaryName}`,
    import.meta.url,
  );
  return fileURLToPath(url);
}

/**
 * Finds the sidecar binary: `SIDEKICKS_PTY_SIDECAR_BIN` (an absolute path), the published platform
 * package, then the workspace release and debug builds. Throws `PtyBackendUnavailableError`
 * listing each step's outcome when all miss; `details.cause` is the step 2 error.
 */
export function resolveSidecarBinaryPath(opts?: ResolveSidecarBinaryPathOptions): string {
  const env: NodeJS.ProcessEnv = opts?.env ?? process.env;
  const nodeRequire: { resolve: (id: string) => string } =
    opts?.nodeRequire ?? createRequire(import.meta.url);
  const existsSync: (path: string) => boolean = opts?.existsSync ?? fsExistsSync;
  const platform: NodeJS.Platform = opts?.platform ?? process.platform;
  const binaryName: string = platformBinaryName("sidecar", platform);

  const attempts: ResolutionAttempt[] = [];

  const fromEnv: string | undefined = env["SIDEKICKS_PTY_SIDECAR_BIN"];
  if (fromEnv === undefined || fromEnv.length === 0) {
    attempts.push({
      step: 1,
      description: "env-var SIDEKICKS_PTY_SIDECAR_BIN",
      outcome: "unset",
    });
  } else if (!pathIsAbsolute(fromEnv)) {
    // A relative path would depend on `process.cwd()`.
    attempts.push({
      step: 1,
      description: "env-var SIDEKICKS_PTY_SIDECAR_BIN",
      outcome: `rejected (relative path; absolute required): ${JSON.stringify(fromEnv)}`,
    });
  } else if (!existsSync(fromEnv)) {
    // A missing file would spend crash budget on a doomed spawn, and five typos would disable the
    // host for good.
    attempts.push({
      step: 1,
      description: "env-var SIDEKICKS_PTY_SIDECAR_BIN",
      outcome: `rejected (path does not exist): ${JSON.stringify(fromEnv)}`,
    });
  } else {
    return fromEnv;
  }

  const arch: string = process.arch;
  const publishedId: string = publishedPackageIdFor(platform, arch, binaryName);
  // Kept for `details.cause` on the final throw.
  let step2Cause: unknown;
  try {
    const resolved: string = nodeRequire.resolve(publishedId);
    return resolved;
  } catch (err: unknown) {
    step2Cause = err;
    attempts.push({
      step: 2,
      description: `require.resolve(${JSON.stringify(publishedId)})`,
      outcome: `threw: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  const releasePath: string = opts?.releasePath ?? workspaceTargetPath("release", binaryName);
  if (existsSync(releasePath)) {
    return releasePath;
  }
  attempts.push({
    step: 3,
    description: `packages/sidecar-rust-pty/target/release/${binaryName}`,
    outcome: `not found at ${releasePath}`,
  });

  const debugPath: string = opts?.debugPath ?? workspaceTargetPath("debug", binaryName);
  if (existsSync(debugPath)) {
    return debugPath;
  }
  attempts.push({
    step: 4,
    description: `packages/sidecar-rust-pty/target/debug/${binaryName}`,
    outcome: `not found at ${debugPath}`,
  });

  // `details.cause` is the step 2 error, the closest miss to a production install.
  const enumerated: string = attempts
    .map((a) => `  step ${a.step} (${a.description}): ${a.outcome}`)
    .join("\n");
  const details: PtyBackendUnavailableDetails =
    step2Cause !== undefined
      ? { attemptedBackend: "rust-sidecar", cause: step2Cause }
      : { attemptedBackend: "rust-sidecar" };
  throw new PtyBackendUnavailableError(
    details,
    `RustSidecarPtyHost: sidecar binary not found on any of the four resolution steps. ` +
      `Attempts:\n${enumerated}\n` +
      `Set SIDEKICKS_PTY_SIDECAR_BIN=<absolute path> to override, or install the ` +
      `published @ai-sidekicks/pty-sidecar package, or run \`cargo build --release\` ` +
      `inside packages/sidecar-rust-pty/.`,
  );
}
