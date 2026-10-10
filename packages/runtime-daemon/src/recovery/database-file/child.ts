// A copy of one file in a child process of its own, which the daemon ends at once at a stop: Node's
// copy, as a clone where the file system makes one. A failed copy exits with its error on standard
// error, which the daemon reads.

import { constants } from "node:fs";
import { copyFile } from "node:fs/promises";

const [sourcePath, destinationPath] = process.argv.slice(2);
if (sourcePath === undefined || destinationPath === undefined) {
  throw new Error("The file copy is started with the file and the path of its copy");
}
await copyFile(sourcePath, destinationPath, constants.COPYFILE_FICLONE);
