// Inside a WSL distribution the Windows drives are mounted into Linux (`/mnt/c` unless `wsl.conf`
// moves them), and WSL appends the Windows search path under them. A Windows `claude` or `node`
// found there fails inside the distribution, so the folders under these mounts are left out of the
// providers' search path.

import { readFile } from "node:fs/promises";

// WSL's own kernels name Microsoft in their release: `5.15.167.4-microsoft-standard-WSL2` on WSL 2,
// `4.4.0-19041-Microsoft` on WSL 1.
const WSL_KERNEL_RELEASE = /microsoft/i;

// WSL 2 mounts a drive over 9p with `aname=drvfs` among its options; WSL 1 as `drvfs`.
const DRVFS_PLAN9_OPTION = /(?:^|[,;])aname=drvfs(?:[,;]|$)/;

// The mount table escapes a space, tab, newline and backslash in a path as three octal digits.
const MOUNT_TABLE_ESCAPE = /\\([0-7]{3})/g;

/**
 * The folders the Windows drives are mounted at, read from the kernel release and the mount table
 * (`/proc/self/mounts`); empty outside a WSL distribution. Inside one, every `virtiofs` mount is a
 * drive too, since WSL mounts nothing else that way.
 */
export function findWindowsDriveMounts(kernelRelease: string, mountTable: string): string[] {
  if (!WSL_KERNEL_RELEASE.test(kernelRelease)) {
    return [];
  }
  const mounts: string[] = [];
  for (const line of mountTable.split("\n")) {
    const [, mountPoint, fileSystemType, options] = line.split(" ");
    if (mountPoint === undefined || fileSystemType === undefined || options === undefined) {
      continue;
    }
    const isDrive =
      fileSystemType === "drvfs" ||
      fileSystemType === "virtiofs" ||
      (fileSystemType === "9p" && DRVFS_PLAN9_OPTION.test(options));
    if (isDrive) {
      mounts.push(
        mountPoint.replace(MOUNT_TABLE_ESCAPE, (_escape, octal: string) =>
          String.fromCharCode(Number.parseInt(octal, 8)),
        ),
      );
    }
  }
  return mounts;
}

/** Reads the folders the Windows drives are mounted at on this Linux machine; rejects on a read. */
export async function readWindowsDriveMounts(): Promise<string[]> {
  const [kernelRelease, mountTable] = await Promise.all([
    readFile("/proc/sys/kernel/osrelease", "utf8"),
    readFile("/proc/self/mounts", "utf8"),
  ]);
  return findWindowsDriveMounts(kernelRelease, mountTable);
}
