// The Windows drives inside a WSL distribution, read from the kernel release and the mount table:
// every way WSL mounts a drive is found, a path's escapes are decoded, and another Linux machine
// has none.

import { describe, expect, it } from "vitest";

import { findWindowsDriveMounts } from "../windows-drive-mounts.js";

// Lines in the form `/proc/self/mounts` prints them.
const MOUNT_TABLE = [
  "/dev/sdc / ext4 rw,relatime,discard,errors=remount-ro,data=ordered 0 0",
  "none /mnt/wsl tmpfs rw,relatime 0 0",
  // WSL 2 over 9p, with the device named by its drive or as `drvfs`.
  "C:\\134 /mnt/c 9p rw,noatime,dirsync,aname=drvfs;path=C:\\134;uid=1000;gid=1000;" +
    "symlinkroot=/mnt/,mmap,access=client,msize=65536,trans=fd,rfd=5,wfd=5 0 0",
  "drvfs /mnt/d 9p rw,noatime,aname=drvfs;path=D:\\134;uid=1000;gid=1000," +
    "msize=262144,trans=virtio 0 0",
  // WSL 1.
  "E: /mnt/e drvfs rw,noatime,uid=1000,gid=1000 0 0",
  // WSL 2 over virtiofs, at a folder with a space in its name.
  "drvfsa /mnt/backup\\040drive virtiofs rw,relatime 0 0",
  // A 9p share that is no Windows drive.
  "server /srv/share 9p rw,trans=tcp,aname=export 0 0",
  "",
].join("\n");

describe("findWindowsDriveMounts", () => {
  it("finds every drive WSL mounts and nothing else", () => {
    expect(
      findWindowsDriveMounts("5.15.167.4-microsoft-standard-WSL2\n", MOUNT_TABLE),
    ).toStrictEqual(["/mnt/c", "/mnt/d", "/mnt/e", "/mnt/backup drive"]);
    expect(findWindowsDriveMounts("4.4.0-19041-Microsoft\n", MOUNT_TABLE)).toHaveLength(4);
  });

  it("finds none outside a WSL distribution", () => {
    expect(findWindowsDriveMounts("6.8.0-45-generic\n", MOUNT_TABLE)).toStrictEqual([]);
  });
});
