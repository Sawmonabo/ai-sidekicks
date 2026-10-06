// The longest Unix domain socket path this platform binds, read from the platform itself. A socket
// address is a fixed-size field whose width differs by platform, and the bind refuses a longer
// path with a bare EINVAL, so the daemon measures the width once and checks its own path before
// binding. The measurement asks the platform's bind about addresses under a folder that does not
// exist: a path that fits is looked up and fails there, one that does not fails with EINVAL before
// any lookup, and no file is ever created. That folder sits directly under the root, the shortest
// base there is, so no environment setting such as a long `TMPDIR` can make every probe too long.

import { randomBytes } from "node:crypto";
import * as net from "node:net";
import * as path from "node:path";

// Past this no socket address field reaches; a platform wider than it reports this figure.
const SEARCH_CEILING_BYTES = 65_536;

let measuredLimit: Promise<number> | undefined;

/**
 * Resolves with the longest socket path, in bytes, this platform binds; measured on the first call
 * and kept for the life of the process.
 */
export function readSocketPathLimit(): Promise<number> {
  measuredLimit ??= measureSocketPathLimit();
  return measuredLimit;
}

async function measureSocketPathLimit(): Promise<number> {
  // A folder that does not exist, so every path that fits stops at its lookup.
  const missingFolder = path.join("/", `.sidekicks-socket-probe-${randomBytes(8).toString("hex")}`);
  // Lengths are in bytes, as the address field counts them; the padding is one byte a character.
  const prefix = `${missingFolder}/`;
  const prefixBytes = Buffer.byteLength(prefix, "utf8");
  const pathOfLength = (length: number): string =>
    prefix + "a/".repeat(length).slice(0, length - prefixBytes);

  // Binary search for the longest length that fits, between one that surely does and the ceiling.
  let fits = prefixBytes + 1;
  if (!(await isAddressAccepted(pathOfLength(fits)))) {
    throw new Error(`This platform binds no socket path of even ${String(fits)} bytes`);
  }
  if (await isAddressAccepted(pathOfLength(SEARCH_CEILING_BYTES))) {
    return SEARCH_CEILING_BYTES;
  }
  let tooLong = SEARCH_CEILING_BYTES;
  while (tooLong - fits > 1) {
    const middle = Math.floor((fits + tooLong) / 2);
    if (await isAddressAccepted(pathOfLength(middle))) {
      fits = middle;
    } else {
      tooLong = middle;
    }
  }
  return fits;
}

// EINVAL is the platform refusing the address itself; ENOENT, ENOTDIR or EACCES means it took the
// address and failed the lookup inside it. Anything else is a failure the caller must see.
function isAddressAccepted(socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EINVAL") {
        resolve(false);
      } else if (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EACCES") {
        resolve(true);
      } else {
        reject(error);
      }
    });
    server.once("listening", () => {
      server.close();
      reject(new Error(`The socket path probe unexpectedly bound ${socketPath}`));
    });
    server.listen(socketPath);
  });
}
