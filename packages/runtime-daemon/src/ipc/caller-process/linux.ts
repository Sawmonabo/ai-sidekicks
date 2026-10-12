// Linux: the connected process's id from the socket's `SO_PEERCRED` credentials, called through
// `koffi`, and a process's parent from field 4 of `/proc/<id>/stat`.

import { readFile } from "node:fs/promises";

import { importKoffi } from "../../koffi.js";
import { readSocketDescriptor, type CallerProcessReader } from "./contract.js";

// <sys/socket.h>: the socket level and its peer credentials option, which fills a
// `struct ucred { pid_t pid; uid_t uid; gid_t gid; }`.
const SOL_SOCKET = 1;
const SO_PEERCRED = 17;
const PEER_CREDENTIALS_BYTES = 12;

/** Binds `getsockopt` from the C library Node runs on; rejects when `koffi` cannot be loaded. */
export async function openLinuxCallerProcessReader(): Promise<CallerProcessReader> {
  const koffi = await importKoffi("telling which process connected to the daemon on Linux");
  // The running program's own symbols, so glibc and musl alike answer.
  const library = koffi.load(null);
  const getsockopt = library.func(
    "int getsockopt(int socket, int level, int option_name, _Out_ uint8_t *option_value, " +
      "_Inout_ uint32_t *option_len)",
  );
  return {
    readConnectedProcessId: (socket) => {
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
  let stat: string;
  try {
    stat = await readFile(`/proc/${String(processId)}/stat`, "utf8");
  } catch (failure) {
    // A process gone before the open has no folder; one ending during the read answers ESRCH.
    const code = failure instanceof Error && "code" in failure ? failure.code : undefined;
    if (code === "ENOENT" || code === "ESRCH") {
      return undefined;
    }
    throw failure;
  }
  // Field 2, the process's name, sits in parentheses and may hold spaces and parentheses itself,
  // so the fields are counted from after the last `)`: field 3, the state, first, the parent next.
  const parentField = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1];
  const parentProcessId = Number(parentField);
  if (parentField === undefined || !Number.isInteger(parentProcessId)) {
    throw new Error(`/proc/${String(processId)}/stat has no parent field`);
  }
  return parentProcessId;
}
