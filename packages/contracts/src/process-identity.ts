// A running process as the system knows it: its id, the boot it runs in, and the system's own
// record of when it started. The system hands a freed id to a new process with a new start, and a
// reboot changes the boot, so two readings of one process match exactly and a reading of any
// other process does not. The service reports its own; a client that ends a service it found
// running reads that id again before each signal and signals only on a match. Both sides read
// through the reader here, so both write the same text for the same process; each hands it the
// system's file read and program run, since this package stays free of any one runtime.
import { z } from "zod";

/** A process as the system knows it. */
export interface ProcessIdentity {
  /** The operating-system process id. */
  processId: number;
  /** The id of the boot the process runs in: Linux's boot id, macOS's boot session id. */
  bootId: string;
  /**
   * The system's own record of when the process started, as the system writes it: Linux's clock
   * ticks since boot, macOS's start instant. Compared only for equality, never read as a time, so
   * a change of the clock does not change it.
   */
  processStartTime: string;
}

/** The longest boot id or start record a reply carries. */
const PROCESS_IDENTITY_TEXT_MAX_LEN = 128;

/** Parses a {@link ProcessIdentity}. */
export const ProcessIdentitySchema: z.ZodType<ProcessIdentity> = z
  .object({
    processId: z.number().int().positive(),
    bootId: z.string().min(1).max(PROCESS_IDENTITY_TEXT_MAX_LEN),
    processStartTime: z.string().min(1).max(PROCESS_IDENTITY_TEXT_MAX_LEN),
  })
  .strict();

/** Whether two readings are of the same process. */
export function isSameProcess(first: ProcessIdentity, second: ProcessIdentity): boolean {
  return (
    first.processId === second.processId &&
    first.bootId === second.bootId &&
    first.processStartTime === second.processStartTime
  );
}

/** What the reader reads the system through: Node's own calls, handed in by each side. */
export interface ProcessIdentitySystem {
  /** `process.platform`. */
  readonly platform: string;
  /** Reads a text file; rejects as `fs.promises.readFile` does, with `code` `ENOENT` when absent. */
  readonly readTextFile: (path: string) => Promise<string>;
  /**
   * Runs a program with exactly `environment`; rejects as a promisified `execFile` does when it
   * exits other than 0, with the exit status as `code` and what it wrote as `stdout`.
   */
  readonly runProgram: (
    file: string,
    args: readonly string[],
    environment: Readonly<Record<string, string>>,
  ) => Promise<{ readonly stdout: string }>;
}

/**
 * A reader of processes on macOS or Linux, which answers `undefined` when no process has the id.
 * It rejects on any other system and when the system's reading fails. It reads the boot once and
 * keeps it, since the boot cannot change while the reading process runs.
 */
export function createProcessIdentityReader(
  system: ProcessIdentitySystem,
): (processId: number) => Promise<ProcessIdentity | undefined> {
  let bootIdReading: Promise<string> | undefined;
  const readBootId = (read: () => Promise<string>): Promise<string> => {
    // A failed reading is dropped, so the next one tries again.
    bootIdReading ??= read().then(
      (text) => text.trim(),
      (failure: unknown) => {
        bootIdReading = undefined;
        throw failure;
      },
    );
    return bootIdReading;
  };
  switch (system.platform) {
    case "darwin":
      return async (processId) => {
        const startTime = await readMacProcessStartTime(system, processId);
        if (startTime === undefined) {
          return undefined;
        }
        const bootId = await readBootId(async () => {
          const { stdout } = await system.runProgram(
            "/usr/sbin/sysctl",
            ["-n", "kern.bootsessionuuid"],
            {},
          );
          return stdout;
        });
        return { processId, bootId, processStartTime: startTime };
      };
    case "linux":
      return async (processId) => {
        const startTime = await readLinuxProcessStartTime(system, processId);
        if (startTime === undefined) {
          return undefined;
        }
        const bootId = await readBootId(() =>
          system.readTextFile("/proc/sys/kernel/random/boot_id"),
        );
        return { processId, bootId, processStartTime: startTime };
      };
    default:
      return () =>
        Promise.reject(
          new Error(`This system's processes cannot be identified here: ${system.platform}`),
        );
  }
}

// `ps` writes the start in the reader's time zone and language, so both are fixed: the service and
// the client run with different environments and must write the same text.
const PS_ENVIRONMENT = { LC_ALL: "C", TZ: "UTC" };

async function readMacProcessStartTime(
  system: ProcessIdentitySystem,
  processId: number,
): Promise<string | undefined> {
  try {
    const { stdout } = await system.runProgram(
      "/bin/ps",
      ["-o", "lstart=", "-p", String(processId)],
      PS_ENVIRONMENT,
    );
    return stdout.trim();
  } catch (failure) {
    // `ps` exits 1 and writes nothing when no process has the id.
    if (failureCode(failure) === 1 && failureOutput(failure) === "") {
      return undefined;
    }
    throw failure;
  }
}

async function readLinuxProcessStartTime(
  system: ProcessIdentitySystem,
  processId: number,
): Promise<string | undefined> {
  let stat: string;
  try {
    stat = await system.readTextFile(`/proc/${String(processId)}/stat`);
  } catch (failure) {
    if (failureCode(failure) === "ENOENT") {
      return undefined;
    }
    throw failure;
  }
  // Field 2, the process's name, sits in parentheses and may hold spaces and parentheses itself,
  // so the fields are counted from after the last `)`: field 3 first, the start (field 22) 20th.
  const startTime = stat
    .slice(stat.lastIndexOf(")") + 2)
    .split(" ")
    .at(22 - 3);
  if (startTime === undefined || startTime === "") {
    throw new Error(`/proc/${String(processId)}/stat has no start field`);
  }
  return startTime;
}

function failureCode(failure: unknown): unknown {
  return failure instanceof Error && "code" in failure ? failure.code : undefined;
}

function failureOutput(failure: unknown): unknown {
  return failure instanceof Error && "stdout" in failure ? failure.stdout : undefined;
}
