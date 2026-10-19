// A running process as the system knows it: its id, the boot it runs in, and the system's own
// record of when it started. The system hands a freed id to a new process with a new start, and a
// reboot changes the boot, so two readings of one process match exactly and a reading of any
// other process does not, short of its id being reused within the start record's resolution (one
// second on macOS). The service reports its own; a client that ends a service it found
// running reads that id again before each signal and signals only on a match. Both sides read
// through the reader here of the system they run on, so both write the same text for the same
// process; each hands it the system's file read and program run, since this package stays free of
// any one runtime.
import { z } from "zod";

/** A process as the system knows it. */
export interface ProcessIdentity {
  /** The operating-system process id. */
  processId: number;
  /**
   * The id of the boot the process runs in: Linux's boot id, macOS's boot session id; on Windows
   * one fixed word, since Windows keeps no boot mark a change of the clock leaves alone.
   */
  bootId: string;
  /**
   * The system's own record of when the process started, as the system writes it: Linux's clock
   * ticks since boot, macOS's start instant, Windows' creation time. Compared only for equality,
   * never read as a time, so a change of the clock does not change it.
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

/** What a reader reads the system through: Node's own calls, handed in by each side. */
export interface ProcessIdentitySystem {
  /**
   * Reads a text file; rejects as `fs.promises.readFile` does, with `code` `ENOENT` when absent and
   * `ESRCH` when a process's file goes while it is read.
   */
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
 * Reads the process with an id as the system knows it, `undefined` when no process has the id.
 * Rejects when the system's reading fails.
 */
export type ProcessIdentityReader = (processId: number) => Promise<ProcessIdentity | undefined>;

/** A reader of processes on macOS: `ps` for the start, the boot session id for the boot. */
export function createMacProcessIdentityReader(
  system: ProcessIdentitySystem,
): ProcessIdentityReader {
  const readBootId = keepBootIdReading(async () => {
    const { stdout } = await system.runProgram(
      "/usr/sbin/sysctl",
      ["-n", "kern.bootsessionuuid"],
      {},
    );
    return stdout;
  });
  return async (processId) => {
    const startTime = await readMacProcessStartTime(system, processId);
    if (startTime === undefined) {
      return undefined;
    }
    return { processId, bootId: await readBootId(), processStartTime: startTime };
  };
}

/** A reader of processes on Linux: `/proc/<id>/stat` for the start, the kernel's boot id. */
export function createLinuxProcessIdentityReader(
  system: ProcessIdentitySystem,
): ProcessIdentityReader {
  const readBootId = keepBootIdReading(() =>
    system.readTextFile("/proc/sys/kernel/random/boot_id"),
  );
  return async (processId) => {
    const startTime = await readLinuxProcessStartTime(system, processId);
    if (startTime === undefined) {
      return undefined;
    }
    return { processId, bootId: await readBootId(), processStartTime: startTime };
  };
}

/** The reader on Windows, whose processes are not read: each reading rejects. */
export function createWindowsProcessIdentityReader(): ProcessIdentityReader {
  return () =>
    Promise.reject(new Error("This system's processes cannot be identified here: win32"));
}

// The boot is read once and kept, since it cannot change while the reading process runs. A failed
// reading is dropped, so the next one tries again.
function keepBootIdReading(read: () => Promise<string>): () => Promise<string> {
  let bootIdReading: Promise<string> | undefined;
  return () => {
    bootIdReading ??= read().then(
      (text) => text.trim(),
      (failure: unknown) => {
        bootIdReading = undefined;
        throw failure;
      },
    );
    return bootIdReading;
  };
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

/**
 * The fields of `/proc/<id>/stat` from field 3, the state, on, `undefined` when no process has the
 * id. Rejects when the read fails otherwise.
 */
export async function readLinuxProcessStatFields(
  system: Pick<ProcessIdentitySystem, "readTextFile">,
  processId: number,
): Promise<readonly string[] | undefined> {
  let stat: string;
  try {
    stat = await system.readTextFile(`/proc/${String(processId)}/stat`);
  } catch (failure) {
    // A process gone before the open has no folder; one ending during the read answers ESRCH.
    if (failureCode(failure) === "ENOENT" || failureCode(failure) === "ESRCH") {
      return undefined;
    }
    throw failure;
  }
  // Field 2, the process's name, sits in parentheses and may hold spaces and parentheses itself,
  // so the fields are counted from after the last `)`.
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
}

async function readLinuxProcessStartTime(
  system: ProcessIdentitySystem,
  processId: number,
): Promise<string | undefined> {
  const fields = await readLinuxProcessStatFields(system, processId);
  if (fields === undefined) {
    return undefined;
  }
  // The start is field 22.
  const startTime = fields.at(22 - 3);
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
