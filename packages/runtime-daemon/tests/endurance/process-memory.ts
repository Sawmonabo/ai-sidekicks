// A process's memory as the system charges it, and the processes it started: on macOS through
// `koffi`, `proc_pid_rusage`'s footprint and lifetime peak footprint and `proc_listchildpids`; on
// Linux `/proc/<pid>/status`'s resident and peak resident memory and each thread's `children`.

import { readdir, readFile } from "node:fs/promises";

import { isMissingFileError } from "../../src/file/missing-error.js";
import { importKoffi } from "../../src/pty/koffi.js";

// A process's memory now and at its peak since it started, in bytes.
interface ProcessMemory {
  readonly currentBytes: number;
  readonly peakBytes: number;
}

/**
 * The reads of one system: a live process's memory, `undefined` once it is gone or while it runs as
 * another user (the setuid `ps` the daemon reads a start time with), and its children, none once
 * it is gone.
 */
export interface ProcessMemoryReader {
  readMemory(processId: number): Promise<ProcessMemory | undefined>;
  listChildren(processId: number): Promise<readonly number[]>;
}

// <sys/resource.h>: RUSAGE_INFO_V4, and the byte offsets of `ri_phys_footprint` and
// `ri_lifetime_max_phys_footprint` in `struct rusage_info_v4`.
const RUSAGE_INFO_V4 = 4;
const PHYS_FOOTPRINT_OFFSET = 72;
const LIFETIME_MAX_PHYS_FOOTPRINT_OFFSET = 240;
const RUSAGE_INFO_V4_BYTES = 296;
// <sys/errno.h>: the process runs as another user, and no process has the id.
const EPERM = 1;
const ESRCH = 3;
// More children than a daemon starts at once.
const CHILD_IDS_AT_MOST = 256;

/** The reads of the system the test runs on; throws on a system with neither. */
export async function loadProcessMemoryReader(): Promise<ProcessMemoryReader> {
  if (process.platform === "darwin") {
    return loadDarwinReader();
  }
  if (process.platform === "linux") {
    return linuxReader;
  }
  throw new Error(`No process memory read is written for ${process.platform}.`);
}

async function loadDarwinReader(): Promise<ProcessMemoryReader> {
  const koffi = await importKoffi("reading a process's memory footprint on macOS");
  const system = koffi.load("/usr/lib/libSystem.B.dylib");
  const procPidRusage = system.func(
    "int proc_pid_rusage(int pid, int flavor, _Out_ uint8_t *buffer)",
  );
  const procListChildPids = system.func(
    "int proc_listchildpids(int ppid, _Out_ int *buffer, int buffersize)",
  );
  const usage = Buffer.alloc(RUSAGE_INFO_V4_BYTES);
  const childIds = new Int32Array(CHILD_IDS_AT_MOST);
  return {
    readMemory: (processId) => {
      if ((procPidRusage(processId, RUSAGE_INFO_V4, usage) as number) !== 0) {
        const errno = koffi.errno();
        if (errno === ESRCH || errno === EPERM) {
          return Promise.resolve(undefined);
        }
        throw new Error(`proc_pid_rusage(${String(processId)}) failed with errno ${String(errno)}`);
      }
      return Promise.resolve({
        currentBytes: Number(usage.readBigUInt64LE(PHYS_FOOTPRINT_OFFSET)),
        peakBytes: Number(usage.readBigUInt64LE(LIFETIME_MAX_PHYS_FOOTPRINT_OFFSET)),
      });
    },
    listChildren: (processId) => {
      const count = procListChildPids(processId, childIds, childIds.byteLength) as number;
      if (count < 0) {
        throw new Error(`proc_listchildpids(${String(processId)}) failed`);
      }
      return Promise.resolve([...childIds.subarray(0, count)]);
    },
  };
}

const linuxReader: ProcessMemoryReader = {
  readMemory: async (processId) => {
    const status = await readUnlessGone(() =>
      readFile(`/proc/${String(processId)}/status`, "utf8"),
    );
    if (status === undefined) {
      return undefined;
    }
    return {
      currentBytes: statusKibibytes(status, "VmRSS") * 1024,
      peakBytes: statusKibibytes(status, "VmHWM") * 1024,
    };
  },
  listChildren: async (processId) => {
    const taskFolder = `/proc/${String(processId)}/task`;
    const threadIds = await readUnlessGone(() => readdir(taskFolder));
    const children: number[] = [];
    for (const threadId of threadIds ?? []) {
      const listed = await readUnlessGone(() =>
        readFile(`${taskFolder}/${threadId}/children`, "utf8"),
      );
      children.push(...(listed ?? "").split(" ").filter(Boolean).map(Number));
    }
    return children;
  },
};

// A read under /proc, or `undefined` once its process or thread is gone.
async function readUnlessGone<Read>(read: () => Promise<Read>): Promise<Read | undefined> {
  try {
    return await read();
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

function statusKibibytes(status: string, field: string): number {
  const kibibytes = new RegExp(`^${field}:\\s+(\\d+) kB$`, "mu").exec(status)?.[1];
  if (kibibytes === undefined) {
    throw new Error(`A process's status shows no ${field}.`);
  }
  return Number(kibibytes);
}
