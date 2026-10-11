// Where a folder sits on a Windows computer with WSL, read from its path's form. The service runs
// on Windows itself or inside one WSL distribution. Seen from either side, the other side's disk is
// reachable but slower: a Windows drive mounted into the distribution, or a distribution's folder
// reached from Windows over `\\wsl$\<distro>\` or `\\wsl.localhost\<distro>\`. A folder inside
// another distribution than the service's own is out of reach. Each system's module picks its
// place; everywhere else both answers are false.

import * as path from "node:path";

// `\\wsl$\Ubuntu\home\…` or `\\wsl.localhost\Ubuntu\home\…`, either slash, any case.
const WSL_DISTRIBUTION_PATH = /^(?:\\\\|\/\/)wsl(?:\$|\.localhost)[\\/]([^\\/]+)/i;

/** Answers where a folder sits, from its path alone. */
export interface FolderPlace {
  /** A folder on the other side's disk of a Windows computer with WSL, read more slowly. */
  isOnOtherSideDisk(folderPath: string): boolean;
  /** A folder inside another WSL distribution than the one the service runs in. */
  isInAnotherDistribution(folderPath: string): boolean;
}

/** The place on a computer with no WSL on either side of the service: every folder is its own. */
export const OWN_DISK_FOLDER_PLACE: FolderPlace = {
  isOnOtherSideDisk: () => false,
  isInAnotherDistribution: () => false,
};

/** The place on Windows itself, where a distribution's folder is on the other side's disk. */
export const WINDOWS_FOLDER_PLACE: FolderPlace = {
  isOnOtherSideDisk: (folderPath) => distributionOf(folderPath) !== undefined,
  isInAnotherDistribution: () => false,
};

/**
 * The place inside the WSL distribution `distributionName` (`WSL_DISTRO_NAME`), with the Windows
 * drives mounted at `windowsDriveMounts`.
 */
export function createWslFolderPlace(
  distributionName: string,
  windowsDriveMounts: readonly string[],
): FolderPlace {
  const ownDistribution = distributionName.toLowerCase();
  return {
    isOnOtherSideDisk: (folderPath) =>
      windowsDriveMounts.some((mount) => isWithin(folderPath, mount)),
    isInAnotherDistribution: (folderPath) => {
      const distribution = distributionOf(folderPath);
      return distribution !== undefined && distribution.toLowerCase() !== ownDistribution;
    },
  };
}

function distributionOf(folderPath: string): string | undefined {
  return WSL_DISTRIBUTION_PATH.exec(folderPath)?.[1];
}

// Whether `folderPath` is `folder` or inside it, by whole path components.
function isWithin(folderPath: string, folder: string): boolean {
  const relative = path.posix.relative(folder, folderPath);
  return relative === "" || (!relative.startsWith("..") && !path.posix.isAbsolute(relative));
}
