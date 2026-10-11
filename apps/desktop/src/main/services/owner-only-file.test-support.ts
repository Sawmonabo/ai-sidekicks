// The answers an operating system gives a suite that writes owner-only files, so each case runs
// once with the folder flushed after the rename and once without, and the host's own answer for a
// suite that writes as the host does.

import { selectMainOperatingSystem } from "../operating-system/selection.js";
import type { OwnerOnlyFileOperatingSystem } from "./owner-only-file.js";

/** One answer a write can be given, and whether this machine can carry it out. */
export interface FolderFlushAnswer {
  /** A case title naming the answer. */
  readonly title: string;
  readonly operatingSystem: OwnerOnlyFileOperatingSystem;
  /** False for a flush on a host whose own module answers that it cannot flush a folder. */
  readonly canRunHere: boolean;
}

/** Both answers: the folder flushed after the rename, and left unflushed. */
export function folderFlushAnswers(): readonly FolderFlushAnswer[] {
  const hostFlushes = hostOwnerOnlyFileOperatingSystem().flushesFolderAfterRename;
  return [
    {
      title: "with the folder flushed",
      operatingSystem: { flushesFolderAfterRename: true },
      canRunHere: hostFlushes,
    },
    {
      title: "with the folder left unflushed",
      operatingSystem: { flushesFolderAfterRename: false },
      canRunHere: true,
    },
  ];
}

/** What the module of the machine running the suite answers a write. */
export function hostOwnerOnlyFileOperatingSystem(): OwnerOnlyFileOperatingSystem {
  return selectMainOperatingSystem(process.platform);
}
