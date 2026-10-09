// `repo.folderList`: one folder's child folders for the folder picker, each marked when it is a
// repository. A read, so the gate never refuses it.

import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import { REPO_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/repo/methods";

import type { FolderListService } from "../../../workspace/folder/list.js";
import { registerDescribedMethod } from "../register-described-method.js";

/** What `repo.folderList`'s handler calls. */
export interface RepoFolderMethodsDeps {
  readonly folders: Pick<FolderListService, "list">;
}

/** Binds `repo.folderList` onto the registry. */
export function registerRepoFolderMethods(
  registry: MethodRegistry,
  deps: RepoFolderMethodsDeps,
): void {
  registerDescribedMethod(registry, REPO_METHOD_DESCRIPTORS["repo.folderList"], (request) =>
    deps.folders.list(request),
  );
}
