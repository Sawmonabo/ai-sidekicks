// macOS: the peer process's id from the socket's `LOCAL_PEERPID` option, and a process's
// parent from `proc_pidinfo`'s short BSD record, both called through `koffi`.

import { importKoffi } from "../../koffi.js";
import type { CallerProcessReader } from "./contract.js";
import { readSocketDescriptor } from "./socket-descriptor.js";

// <sys/un.h>: the local socket level and its peer process id option.
const SOL_LOCAL = 0;
const LOCAL_PEERPID = 2;
// <sys/proc_info.h>: PROC_PIDT_SHORTBSDINFO, the size of `struct proc_bsdshortinfo`, and the byte
// offset of its `pbsi_ppid`.
const PROC_PIDT_SHORTBSDINFO = 13;
const SHORT_BSD_INFO_BYTES = 64;
const PARENT_PROCESS_ID_OFFSET = 4;
// <sys/errno.h>: no process has the id; the socket's other end has closed.
const ESRCH = 3;
const ENOTCONN = 57;
const PROCESS_ID_BYTES = 4;

/** Binds the calls from the system library; rejects when `koffi` cannot be loaded. */
export async function openMacCallerProcessReader(): Promise<CallerProcessReader> {
  const koffi = await importKoffi(
    "telling which process is at the other end of a local socket on macOS",
  );
  const system = koffi.load("/usr/lib/libSystem.B.dylib");
  const getsockopt = system.func(
    "int getsockopt(int socket, int level, int option_name, _Out_ uint8_t *option_value, " +
      "_Inout_ uint32_t *option_len)",
  );
  const procPidInfo = system.func(
    "int proc_pidinfo(int pid, int flavor, uint64_t arg, _Out_ uint8_t *buffer, int buffersize)",
  );
  return {
    readPeerProcessId: (socket) => {
      const value = Buffer.alloc(PROCESS_ID_BYTES);
      const length = [PROCESS_ID_BYTES];
      const descriptor = readSocketDescriptor(socket);
      if ((getsockopt(descriptor, SOL_LOCAL, LOCAL_PEERPID, value, length) as number) !== 0) {
        const errno = koffi.errno();
        if (errno === ENOTCONN) {
          return undefined;
        }
        throw new Error(`getsockopt(LOCAL_PEERPID) failed with errno ${String(errno)}`);
      }
      return value.readInt32LE(0);
    },
    readParentProcessId: (processId) => {
      const info = Buffer.alloc(SHORT_BSD_INFO_BYTES);
      const written = procPidInfo(
        processId,
        PROC_PIDT_SHORTBSDINFO,
        0,
        info,
        SHORT_BSD_INFO_BYTES,
      ) as number;
      if (written === SHORT_BSD_INFO_BYTES) {
        return Promise.resolve(info.readUInt32LE(PARENT_PROCESS_ID_OFFSET));
      }
      const errno = koffi.errno();
      if (written <= 0 && errno === ESRCH) {
        return Promise.resolve(undefined);
      }
      return Promise.reject(
        new Error(
          `proc_pidinfo(${String(processId)}) wrote ${String(written)} bytes with errno ` +
            String(errno),
        ),
      );
    },
  };
}
