// Windows: `GetProcessMemoryInfo`'s `PeakWorkingSetSize`, the peak of a process's working set, read
// through `koffi` on a handle opened for the read and closed after it.

import { importKoffi } from "../../koffi.js";
import type { ProcessPeakReader } from "./contract.js";

// <winnt.h>: the access right `GetProcessMemoryInfo` needs. <winerror.h>: the process id names no
// process, and the process runs as another user.
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_ACCESS_DENIED = 5;

type PeakRead = (processId: number) => { peakBytes: number } | { lastError: number };

let peakReadLoading: Promise<PeakRead> | undefined;

// Binds the calls once per process; a failed load is dropped, so the next read tries again.
function loadPeakRead(): Promise<PeakRead> {
  peakReadLoading ??= bindPeakRead().catch((failure: unknown) => {
    peakReadLoading = undefined;
    throw failure;
  });
  return peakReadLoading;
}

async function bindPeakRead(): Promise<PeakRead> {
  const koffi = await importKoffi("reading a process's peak memory on Windows");
  const kernel32 = koffi.load("kernel32.dll");
  const counters = koffi.struct("PROCESS_MEMORY_COUNTERS", {
    cb: "uint32_t",
    PageFaultCount: "uint32_t",
    PeakWorkingSetSize: "size_t",
    WorkingSetSize: "size_t",
    QuotaPeakPagedPoolUsage: "size_t",
    QuotaPagedPoolUsage: "size_t",
    QuotaPeakNonPagedPoolUsage: "size_t",
    QuotaNonPagedPoolUsage: "size_t",
    PagefileUsage: "size_t",
    PeakPagefileUsage: "size_t",
  });
  const countersBytes = koffi.sizeof(counters);
  const openProcess = kernel32.func(
    "void * __stdcall OpenProcess(uint32_t dwDesiredAccess, int bInheritHandle, " +
      "uint32_t dwProcessId)",
  );
  const getProcessMemoryInfo = kernel32.func(
    "int __stdcall K32GetProcessMemoryInfo(void *Process, " +
      "_Out_ PROCESS_MEMORY_COUNTERS *ppsmemCounters, uint32_t cb)",
  );
  const closeHandle = kernel32.func("int __stdcall CloseHandle(void *hObject)");
  const getLastError = kernel32.func("uint32_t __stdcall GetLastError()");

  return (processId) => {
    const handle: unknown = openProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, processId);
    if (handle === null) {
      return { lastError: getLastError() as number };
    }
    const read: { PeakWorkingSetSize?: number | bigint } = {};
    const hasRead = (getProcessMemoryInfo(handle, read, countersBytes) as number) !== 0;
    const readError = hasRead ? 0 : (getLastError() as number);
    if ((closeHandle(handle) as number) === 0) {
      throw new Error(`CloseHandle failed with error ${String(getLastError())}`);
    }
    return hasRead ? { peakBytes: Number(read.PeakWorkingSetSize) } : { lastError: readError };
  };
}

/** Reads a process's peak working set on Windows. */
export const WINDOWS_PROCESS_PEAK_READER: ProcessPeakReader = {
  readPeakBytes: async (processId) => {
    const peakRead = await loadPeakRead();
    const outcome = peakRead(processId);
    if ("peakBytes" in outcome) {
      return outcome.peakBytes;
    }
    if (
      outcome.lastError === ERROR_INVALID_PARAMETER ||
      outcome.lastError === ERROR_ACCESS_DENIED
    ) {
      return undefined;
    }
    throw new Error(
      `Reading the memory of process ${String(processId)} failed with error ` +
        String(outcome.lastError),
    );
  },
};
