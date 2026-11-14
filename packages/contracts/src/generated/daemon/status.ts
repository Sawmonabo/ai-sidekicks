// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// `daemon.status.read`: the service's own facts in one reply, and `daemon.crashReport.list`: the crash reports this machine keeps.

import type { WireInstant } from "../internal/wire-scalars.js";
import type { EmptyPayload } from "../method-descriptor.js";
import type { DistroName } from "../place.js";
import type { ProcessIdentity } from "../process-identity.js";
import type { ProviderWakeHelperState } from "../provider/account/methods.js";
import type { ReleaseVersion } from "../release-manifest.js";
import type { DaemonRecoveryStatus } from "./recovery.js";

/** The longest free-form text the status carries, in code points. */
export const DAEMON_STATUS_TEXT_MAX_LEN = 4096 as const;

/** The most frames a report keeps of the crashing thread's stack. */
export const CRASH_REPORT_STACK_MAX_FRAMES = 256 as const;

/**
 * Where the service is in its own life.
 */
export type DaemonProcessState = "running" | "starting" | "stopping" | "degraded";
/**
 * Where one WSL 2 distribution stands: running, stopped, or not answering since the time WSL
 * stopped answering.
 */
export type DaemonWslDistributionStatus =
  | {
      state: "running";
    }
  | {
      state: "stopped";
    }
  | {
      state: "notAnswering";
      /**
       * When WSL stopped answering.
       */
      since: WireInstant;
    };
/**
 * Why the file on Linux keeps its secrets plain.
 */
export type DaemonSecretsPlainReason = "noSealService" | "sealFailed" | "bootBound";
/**
 * Why the sealed file cannot be opened.
 */
export type DaemonSecretsFileUnopened =
  | "sealServiceMissing"
  | "sealServiceFailing"
  | "chipUnavailable"
  | "keyChanged";
/**
 * The file the service keeps its secrets in, tagged by how they are protected: a sealed file
 * by the weakest key any of them is sealed with, carrying why it cannot be opened while it
 * cannot, and a plain file carrying why it is plain on Linux.
 */
export type DaemonSecretsFile =
  | {
      protection: "sealedWithChip";
      /**
       * The file's path; only this account can read it.
       */
      path: string;
      /**
       * Why the file cannot be opened; absent while it opens.
       */
      cannotOpen?: DaemonSecretsFileUnopened;
    }
  | {
      protection: "sealedWithSystemKey";
      /**
       * The file's path; only this account can read it.
       */
      path: string;
      /**
       * Why the file cannot be opened; absent while it opens.
       */
      cannotOpen?: DaemonSecretsFileUnopened;
    }
  | {
      protection: "plain";
      /**
       * The file's path; only this account can read it.
       */
      path: string;
      /**
       * Why the file on Linux is plain; absent on a Mac.
       */
      reason?: DaemonSecretsPlainReason;
    };
/**
 * Where the service stands with its keys for other devices.
 */
export type DaemonMachineKeyState = "reading" | "notMinted" | "lost" | "changed";
/**
 * What stopped the service from reading or making its keys.
 */
export type DaemonMachineKeyCause =
  | "locked"
  | "unavailable"
  | "secretsFile"
  | "random"
  | "database"
  | "storedPin";
/**
 * A stack frame's module: its file name, never its path, so no user folder leaks; it holds no
 * `/` or `\`.
 */
export type CrashModuleFileName = string;

/**
 * How much of the machine's processor the service and every process it started use.
 */
export interface DaemonProcessorReading {
  /**
   * A share of the whole machine's processor, from 0 to 100.
   */
  percent: number;
  /**
   * When it was read.
   */
  readAt: WireInstant;
}
/**
 * How much memory the service and every process it started hold.
 */
export interface DaemonMemoryReading {
  /**
   * The resident bytes.
   */
  residentBytes: number;
  /**
   * When it was read.
   */
  readAt: WireInstant;
}
/**
 * One linked device as the relay last saw it, counted since the service started.
 */
export interface DaemonRelayDevice {
  /**
   * The device's name.
   */
  name: string;
  /**
   * Whether it is connected.
   */
  connected: boolean;
  /**
   * How long ago the last frame went out; absent when none has.
   */
  lastFrameOutAgeMs?: number;
  /**
   * How long ago the last frame came in; absent when none has.
   */
  lastFrameInAgeMs?: number;
  /**
   * How many times it reconnected.
   */
  reconnectCount: number;
  /**
   * How many of its frames were refused.
   */
  rejectedFrameCount: number;
}
/**
 * The relay block, present only while a relay is configured.
 */
export interface DaemonRelayStatus {
  /**
   * The linked devices.
   */
  devices: DaemonRelayDevice[];
  /**
   * The pinned relay presented a key other than the one pinned when it was linked.
   */
  pinRefused: boolean;
}
/**
 * One line of the WSL block: a WSL 2 distribution with a WSL server running or a session in it,
 * where it stands and how many sessions run in it.
 */
export interface DaemonWslDistribution {
  /**
   * The distribution.
   */
  distro: DistroName;
  /**
   * Where it stands.
   */
  status: DaemonWslDistributionStatus;
  /**
   * How many sessions run in it.
   */
  sessionCount: number;
}
/**
 * Where the service stands with its keys for other devices while it does not hold them, and
 * what reaches them.
 */
export interface DaemonMachineKey {
  /**
   * Whether the keys are still being read, no key could be read or made, or the one made was
   * lost or changed.
   */
  state: DaemonMachineKeyState;
  /**
   * What stopped the service; absent where the state says it all.
   */
  cause?: DaemonMachineKeyCause;
}
/**
 * Everything a status reader prints, in one reply.
 */
export interface DaemonStatusReadResponse {
  /**
   * Where the service is in its own life.
   */
  processState: DaemonProcessState;
  /**
   * The service's own process as the system knows it, by which a client that found it running
   * ends it and never a process that took over its id.
   */
  processIdentity: ProcessIdentity;
  /**
   * The service's own version.
   */
  version: ReleaseVersion;
  /**
   * The protocol version it speaks.
   */
  protocolVersion: string;
  /**
   * Where it listens.
   */
  transportEndpoint: string;
  /**
   * When it started.
   */
  startedAt: WireInstant;
  /**
   * How long it has run, in milliseconds.
   */
  uptimeMs: number;
  /**
   * The data directory this service holds; a second service cannot hold it.
   */
  dataDirectory: string;
  /**
   * The processor reading, or `null` when it could not be taken at this call.
   */
  processor: DaemonProcessorReading | null;
  /**
   * The memory reading, or `null` when it could not be taken at this call.
   */
  memory: DaemonMemoryReading | null;
  /**
   * Where the service stands in its recovery from the last restart; writes wait for `healthy`.
   */
  recovery: DaemonRecoveryStatus;
  /**
   * The relay, while one is configured.
   */
  relay?: DaemonRelayStatus;
  /**
   * One line per WSL 2 distribution with a WSL server running or a session in it; absent where
   * there is none.
   *
   * @minItems 1
   */
  wsl?: [DaemonWslDistribution, ...DaemonWslDistribution[]];
  /**
   * The file the service keeps its secrets in, how they are protected and, while they cannot be
   * opened, why: present while it holds an item or cannot be opened. That is on Linux, and on a
   * Mac from the logged-out service's takeover until uninstall moves them back, including after
   * it is turned off in Login Items & Extensions.
   */
  secretsFile?: DaemonSecretsFile;
  /**
   * Where this computer's keys for other devices stand while the service does not hold them:
   * `reading` while the start's read of them still runs once this read waited its bound for it,
   * else why a key is not held; absent while both are held.
   */
  machineKey?: DaemonMachineKey;
  /**
   * The machine's one wake helper, `installed`, `turnedOff` or `missing`: present on a system
   * that uses the helper while any account's wake switch is on, and absent on one with no
   * helper.
   */
  wakeHelper?: ProviderWakeHelperState;
}
/**
 * One frame of the crashing thread's stack: the module's file name, never its path, and the
 * offset into it.
 */
export interface CrashStackFrame {
  /**
   * The module's file name.
   */
  module: CrashModuleFileName;
  /**
   * The offset into it.
   */
  offset: number;
}
/**
 * What a panic said: its message and the place in the source it was raised at, each stripped as
 * the rest of the report is.
 */
export interface CrashPanic {
  /**
   * The panic's message, with file paths cut to their names and session ids replaced by
   * stable hashes.
   */
  message: string;
  /**
   * The source file's name and the line and column the panic was raised at.
   */
  location: string;
}
/**
 * A report the service built on this machine from a crash's dump, with personal data stripped:
 * file paths cut to their names and session ids replaced by stable hashes. The dump itself never
 * leaves the machine.
 */
export interface CrashReport {
  /**
   * When it crashed.
   */
  crashedAt: WireInstant;
  /**
   * The crashed process's type as the crash dump records it, such as `renderer`.
   */
  processType: string;
  /**
   * The app's version.
   */
  appVersion: string;
  /**
   * The service's version.
   */
  serviceVersion: string;
  /**
   * The platform.
   */
  platform: string;
  /**
   * The crashing thread's stack, at most [`CRASH_REPORT_STACK_MAX_FRAMES`] frames.
   *
   * @maxItems 256
   */
  stack: CrashStackFrame[];
  /**
   * What the panic said, on a crash the service's own panic ended.
   */
  panic?: CrashPanic;
}
/**
 * The reports this machine keeps, newest first; kept as long as its diagnostic logs.
 */
export interface DaemonCrashReportListResponse {
  /**
   * The reports, newest first.
   */
  reports: CrashReport[];
}

/** The methods of {@link DAEMON_STATUS_METHOD_DESCRIPTORS}, each with its kind. */
export interface DaemonStatusMethodDescriptors {
  readonly "daemon.status.read": {
    readonly method: "daemon.status.read";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "daemon.crashReport.list": {
    readonly method: "daemon.crashReport.list";
    readonly procedureType: "query";
    readonly mutating: false;
  };
}
/** The params, result and emission types of each method of {@link DAEMON_STATUS_METHOD_DESCRIPTORS}. */
export interface DaemonStatusMethodTypes {
  readonly "daemon.status.read": {
    readonly params: EmptyPayload;
    readonly result: DaemonStatusReadResponse;
  };
  readonly "daemon.crashReport.list": {
    readonly params: EmptyPayload;
    readonly result: DaemonCrashReportListResponse;
  };
}
/** The status read and the crash list. */
export const DAEMON_STATUS_METHOD_DESCRIPTORS: DaemonStatusMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "daemon.status.read": /* @__PURE__ */ Object.freeze({
      method: "daemon.status.read",
      procedureType: "query",
      mutating: false,
    }),
    "daemon.crashReport.list": /* @__PURE__ */ Object.freeze({
      method: "daemon.crashReport.list",
      procedureType: "query",
      mutating: false,
    }),
  });
