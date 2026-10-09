// Where a folder sits on a Windows computer with WSL, read from its path's form. The service runs
// on Windows itself or inside one WSL distribution. Seen from either side, the other side's disk is
// reachable but slower: a Windows drive mounted into the distribution, or a distribution's folder
// reached from Windows over `\\wsl$\<distro>\` or `\\wsl.localhost\<distro>\`. A folder inside
// another distribution than the service's own is out of reach. Everywhere else both answers are
// false.

import * as path from "node:path";

import { readWindowsDriveMounts } from "../../daemon/windows-drive-mounts.js";

// `\\wsl$\Ubuntu\home\…` or `\\wsl.localhost\Ubuntu\home\…`, either slash, any case.
const WSL_DISTRIBUTION_PATH = /^(?:\\\\|\/\/)wsl(?:\$|\.localhost)[\\/]([^\\/]+)/i;

/** What the service knows about where folders sit on this computer. */
export interface FolderPlaceFacts {
  /** The platform the service runs on. */
  readonly platform: NodeJS.Platform;
  /** The WSL distribution the service runs in (`WSL_DISTRO_NAME`), or `null` outside one. */
  readonly wslDistributionName: string | null;
  /** Inside a WSL distribution, the folders the Windows drives are mounted at; else empty. */
  readonly windowsDriveMounts: readonly string[];
}

/** Answers where a folder sits, from its path alone. */
export interface FolderPlace {
  /** A folder on the other side's disk of a Windows computer with WSL, read more slowly. */
  isOnOtherSideDisk(folderPath: string): boolean;
  /** A folder inside another WSL distribution than the one the service runs in. */
  isInAnotherDistribution(folderPath: string): boolean;
}

/** The folder place for this computer's facts. */
export function createFolderPlace(facts: FolderPlaceFacts): FolderPlace {
  const distributionOf = (folderPath: string): string | undefined =>
    WSL_DISTRIBUTION_PATH.exec(folderPath)?.[1];
  if (facts.wslDistributionName !== null) {
    const ownDistribution = facts.wslDistributionName.toLowerCase();
    return {
      isOnOtherSideDisk: (folderPath) =>
        facts.windowsDriveMounts.some((mount) => isWithin(folderPath, mount)),
      isInAnotherDistribution: (folderPath) => {
        const distribution = distributionOf(folderPath);
        return distribution !== undefined && distribution.toLowerCase() !== ownDistribution;
      },
    };
  }
  if (facts.platform === "win32") {
    return {
      isOnOtherSideDisk: (folderPath) => distributionOf(folderPath) !== undefined,
      isInAnotherDistribution: () => false,
    };
  }
  return { isOnOtherSideDisk: () => false, isInAnotherDistribution: () => false };
}

/**
 * The folder place of the computer the service runs on: inside a WSL distribution its name and
 * where the Windows drives are mounted, read once. Rejects when the mount table cannot be read.
 */
export async function readFolderPlace(): Promise<FolderPlace> {
  const wslDistributionName = process.env["WSL_DISTRO_NAME"] ?? null;
  return createFolderPlace({
    platform: process.platform,
    wslDistributionName,
    windowsDriveMounts: wslDistributionName === null ? [] : await readWindowsDriveMounts(),
  });
}

// Whether `folderPath` is `folder` or inside it, by whole path components.
function isWithin(folderPath: string, folder: string): boolean {
  const relative = path.posix.relative(folder, folderPath);
  return relative === "" || (!relative.startsWith("..") && !path.posix.isAbsolute(relative));
}
