// `repo.branchList`: a repository's branches for the create form's base list, with how far each
// is ahead of and behind its upstream. A read, so the gate never refuses it.

import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import { REPO_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/repo/methods";

import type { BranchListReader } from "../../../git/worktree/branch-list.js";
import { registerDescribedMethod } from "../register-described-method.js";

/** What `repo.branchList`'s handler calls. */
export interface RepoBranchMethodsDeps {
  readonly branches: Pick<BranchListReader, "read">;
}

/** Binds `repo.branchList` onto the registry. */
export function registerRepoBranchMethods(
  registry: MethodRegistry,
  deps: RepoBranchMethodsDeps,
): void {
  registerDescribedMethod(registry, REPO_METHOD_DESCRIPTORS["repo.branchList"], (request) =>
    deps.branches.read(request),
  );
}
