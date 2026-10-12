// Linux: the peer process's id from the socket's `SO_PEERCRED` credentials, called through
// `koffi`, and a process's parent from field 4 of `/proc/<id>/stat`.

import { readLinuxProcessStatFields } from "@ai-sidekicks/contracts/process-identity";

import { importKoffi } from "../../koffi.js";
import { NODE_SYSTEM_ACCESS } from "../../node-system-access.js";
import type { CallerProcessReader } from "./contract.js";
import { readSocketDescriptor } from "./socket-descriptor.js";

// <sys/socket.h>: the socket level and its peer credentials option, which fills a
// `struct ucred { pid_t pid; uid_t uid; gid_t gid; }`.
const SOL_SOCKET = 1;
const SO_PEERCRED = 17;
const PEER_CREDENTIALS_BYTES = 12;

/** Binds `getsockopt` from the C library Node runs on; rejects when `koffi` cannot be loaded. */
export async function openLinuxCallerProcessReader(): Promise<CallerProcessReader> {
  const koffi = await importKoffi(
    "telling which process is at the other end of a local socket on Linux",
  );
  // The running program's own symbols, so glibc and musl alike answer.
  const library = koffi.load(null);
  const getsockopt = library.func(
    "int getsockopt(int socket, int level, int option_name, _Out_ uint8_t *option_value, " +
      "_Inout_ uint32_t *option_len)",
  );
  return {
    readPeerProcessId: (socket) => {
      const credentials = Buffer.alloc(PEER_CREDENTIALS_BYTES);
      const length = [PEER_CREDENTIALS_BYTES];
      const descriptor = readSocketDescriptor(socket);
      if ((getsockopt(descriptor, SOL_SOCKET, SO_PEERCRED, credentials, length) as number) !== 0) {
        throw new Error(`getsockopt(SO_PEERCRED) failed with errno ${String(koffi.errno())}`);
      }
      return credentials.readInt32LE(0);
    },
    readParentProcessId: readLinuxParentProcessId,
  };
}

async function readLinuxParentProcessId(processId: number): Promise<number | undefined> {
  const fields = await readLinuxProcessStatFields(NODE_SYSTEM_ACCESS, processId);
  if (fields === undefined) {
    return undefined;
  }
  // The parent is field 4.
  const parentField = fields[4 - 3];
  const parentProcessId = Number(parentField);
  if (parentField === undefined || !Number.isInteger(parentProcessId)) {
    throw new Error(`/proc/${String(processId)}/stat has no parent field`);
  }
  return parentProcessId;
}
