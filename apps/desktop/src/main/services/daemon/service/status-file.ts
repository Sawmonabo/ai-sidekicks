// The service's status file in its run folder, which the service writes for its clients to read
// while it is not answering: why its last start failed, the stop under way, or why its last stop
// failed. The addon says where the run folder is, so no TypeScript resolves it.

import { readFile } from "node:fs/promises";

import {
  validateServiceStatusFile,
  type ServiceStatusFile,
} from "@ai-sidekicks/contracts/daemon/service-status";

import { isMissingPath } from "../../missing-path.js";

/**
 * The fact the status file at `filePath` holds, or `undefined` when the service wrote none. Throws
 * when the file cannot be read, or holds anything but one fact in the contract's shape.
 */
export async function readServiceStatusFile(
  filePath: string,
): Promise<ServiceStatusFile | undefined> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (failure) {
    if (isMissingPath(failure)) {
      return undefined;
    }
    throw failure;
  }
  const status: unknown = JSON.parse(text);
  if (!validateServiceStatusFile(status)) {
    throw new Error(`The service's status file ${filePath} does not match its contract.`);
  }
  return status;
}
