// macOS: `proc_pid_rusage`'s `ri_lifetime_max_phys_footprint`, the peak of the footprint the system
// charges a process, read through `koffi` since Node offers no call for another process's memory.

import { importKoffi } from "../../koffi.js";
import type { ProcessPeakReader } from "./contract.js";

// <sys/resource.h>: RUSAGE_INFO_V4, the size of `struct rusage_info_v4`, and the byte offset of its
// `ri_lifetime_max_phys_footprint`.
const RUSAGE_INFO_V4 = 4;
const RUSAGE_INFO_V4_BYTES = 296;
const LIFETIME_MAX_PHYS_FOOTPRINT_OFFSET = 240;
// <sys/errno.h>: the process runs as another user, and no process has the id.
const EPERM = 1;
const ESRCH = 3;

type UsageRead = (processId: number, usage: Buffer) => { errno: number } | undefined;

let usageReadLoading: Promise<UsageRead> | undefined;

// Binds `proc_pid_rusage` once per process; a failed load is dropped, so the next read tries again.
function loadUsageRead(): Promise<UsageRead> {
  usageReadLoading ??= bindUsageRead().catch((failure: unknown) => {
    usageReadLoading = undefined;
    throw failure;
  });
  return usageReadLoading;
}

async function bindUsageRead(): Promise<UsageRead> {
  const koffi = await importKoffi("reading a process's peak memory on macOS");
  const system = koffi.load("/usr/lib/libSystem.B.dylib");
  const procPidRusage = system.func(
    "int proc_pid_rusage(int pid, int flavor, _Out_ uint8_t *buffer)",
  );
  return (processId, usage) =>
    (procPidRusage(processId, RUSAGE_INFO_V4, usage) as number) === 0
      ? undefined
      : { errno: koffi.errno() };
}

/** Reads a process's lifetime peak footprint on macOS. */
export const DARWIN_PROCESS_PEAK_READER: ProcessPeakReader = {
  readPeakBytes: async (processId) => {
    const usageRead = await loadUsageRead();
    const usage = Buffer.alloc(RUSAGE_INFO_V4_BYTES);
    const refusal = usageRead(processId, usage);
    if (refusal === undefined) {
      return Number(usage.readBigUInt64LE(LIFETIME_MAX_PHYS_FOOTPRINT_OFFSET));
    }
    if (refusal.errno === ESRCH || refusal.errno === EPERM) {
      return undefined;
    }
    throw new Error(
      `proc_pid_rusage(${String(processId)}) failed with errno ${String(refusal.errno)}`,
    );
  },
};
