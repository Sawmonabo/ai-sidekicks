// The macOS system calls the orphan defense makes through `koffi`, since Node offers none of them:
// the kernel event queue that reports a process's exit, the list of one user's processes, and the
// read of a process's arguments and environment.

import { importKoffi } from "../../koffi.js";

/** One kernel event, the `struct kevent` of `<sys/event.h>`. */
export interface KernelEvent {
  ident: number;
  filter: number;
  flags: number;
  fflags: number;
  data: number;
  udata: null;
}

/** The macOS calls the orphan defense makes. */
export interface DarwinSystemLibrary {
  /** Opens a kernel event queue; throws when the system refuses one. */
  openKernelQueue(): number;
  /** Applies one change to a queue without waiting; answers the system's `errno` on a refusal. */
  changeKernelQueue(queue: number, change: KernelEvent): { errno: number } | undefined;
  /** Waits off the main thread for one event; `event` is undefined when the wait failed. */
  waitForKernelEvent(queue: number, onEvent: (event: KernelEvent | undefined) => void): void;
  /** Closes a descriptor the library opened. */
  closeDescriptor(descriptor: number): void;
  /** Lists the processes the user with `userId` runs. */
  listUserProcessIds(userId: number): number[];
  /** A process's environment, or `undefined` when the system shows none for it. */
  readProcessEnvironment(processId: number): string[] | undefined;
  /** The `errno` that says no process has the id. */
  readonly noSuchProcessErrno: number;
}

// <sys/sysctl.h>: CTL_KERN, KERN_ARGMAX and KERN_PROCARGS2. <libproc.h>: PROC_UID_ONLY.
const CTL_KERN = 1;
const KERN_ARGMAX = 8;
const KERN_PROCARGS2 = 49;
const PROC_UID_ONLY = 4;
const PROCESS_ID_BYTES = 4;

/** Loads the calls from the system library; throws when `koffi` is missing. */
export async function loadDarwinSystemLibrary(): Promise<DarwinSystemLibrary> {
  const koffi = await importKoffi("watching terminal children for their exit on macOS");
  const system = koffi.load("/usr/lib/libSystem.B.dylib");
  koffi.struct("kevent", {
    ident: "uintptr_t",
    filter: "int16_t",
    flags: "uint16_t",
    fflags: "uint32_t",
    data: "intptr_t",
    udata: "void *",
  });
  const kqueue = system.func("int kqueue()");
  const kevent = system.func(
    "int kevent(int kq, const kevent *changelist, int nchanges, _Out_ kevent *eventlist, " +
      "int nevents, const void *timeout)",
  );
  const close = system.func("int close(int fd)");
  const procListPids = system.func(
    "int proc_listpids(uint32_t type, uint32_t typeinfo, _Out_ void *buffer, int buffersize)",
  );
  const sysctl = system.func(
    "int sysctl(int *name, uint32_t namelen, _Out_ void *oldp, _Inout_ size_t *oldlenp, " +
      "void *newp, size_t newlen)",
  );

  const argumentBytesBuffer = Buffer.alloc(4);
  if (sysctl([CTL_KERN, KERN_ARGMAX], 2, argumentBytesBuffer, [4], null, 0) !== 0) {
    throw new Error(`sysctl(KERN_ARGMAX) failed with errno ${String(koffi.errno())}`);
  }
  const argumentBytesMax = argumentBytesBuffer.readInt32LE(0);
  const noSuchProcessErrno = koffi.os.errno["ESRCH"];
  if (noSuchProcessErrno === undefined) {
    throw new Error("koffi names no ESRCH among the system's error codes");
  }

  return {
    openKernelQueue: () => {
      const queue = kqueue() as number;
      if (queue === -1) {
        throw new Error(`kqueue() failed with errno ${String(koffi.errno())}`);
      }
      return queue;
    },
    changeKernelQueue: (queue, change) =>
      kevent(queue, change, 1, null, 0, null) === -1 ? { errno: koffi.errno() } : undefined,
    waitForKernelEvent: (queue, onEvent) => {
      const event = {} as KernelEvent;
      kevent.async(queue, null, 0, event, 1, null, (error: unknown, count: number) => {
        onEvent(error === null && count === 1 ? event : undefined);
      });
    },
    closeDescriptor: (descriptor) => {
      if (close(descriptor) === -1) {
        throw new Error(`close(${String(descriptor)}) failed with errno ${String(koffi.errno())}`);
      }
    },
    listUserProcessIds: (userId) => {
      // The list can grow between the size read and the read, so the buffer has room to spare.
      const byteCount = (procListPids(PROC_UID_ONLY, userId, null, 0) as number) * 2;
      const buffer = Buffer.alloc(byteCount);
      const written = procListPids(PROC_UID_ONLY, userId, buffer, byteCount) as number;
      if (written <= 0) {
        throw new Error(`proc_listpids failed with errno ${String(koffi.errno())}`);
      }
      const processIds: number[] = [];
      for (let offset = 0; offset < written; offset += PROCESS_ID_BYTES) {
        const processId = buffer.readInt32LE(offset);
        if (processId > 0) {
          processIds.push(processId);
        }
      }
      return processIds;
    },
    readProcessEnvironment: (processId) => {
      const buffer = Buffer.alloc(argumentBytesMax);
      const length = [argumentBytesMax];
      // The system refuses a process that ended or that it hides; either way it shows nothing.
      if (sysctl([CTL_KERN, KERN_PROCARGS2, processId], 3, buffer, length, null, 0) !== 0) {
        return undefined;
      }
      return parseProcessEnvironment(buffer.subarray(0, length[0]));
    },
    noSuchProcessErrno,
  };
}

// KERN_PROCARGS2 answers the argument count, then the executable's path, padding, each argument
// and each environment entry, all ended by a zero byte, and the environment by an empty entry.
// The system strips the environment of its own programs, which then answer none.
function parseProcessEnvironment(bytes: Buffer): string[] | undefined {
  const argumentCount = bytes.readInt32LE(0);
  const strings = bytes.subarray(4).toString("utf8").split("\0");
  let index = 1;
  // The padding after the executable's path is a run of empty strings.
  while (index < strings.length && strings[index] === "") {
    index += 1;
  }
  index += argumentCount;
  const environment: string[] = [];
  for (; index < strings.length && strings[index] !== ""; index += 1) {
    environment.push(strings[index] ?? "");
  }
  return environment.length === 0 ? undefined : environment;
}
