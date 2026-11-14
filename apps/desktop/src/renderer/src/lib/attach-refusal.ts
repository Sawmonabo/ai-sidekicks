// The line a refused attach draws in place where it was asked: a folder that is no git repository,
// and one whose repository a chat's own workspace already holds. Every other refusal reaches the
// screen in the daemon's own words.

import type { ExtendedRefusal } from "./refusal/extensions.js";

/**
 * The line a refused `repoMount.attach` of the folder named `folder` draws, or `undefined` for a
 * refusal it has no words of its own for.
 */
export function attachRefusalLine(refusal: ExtendedRefusal, folder: string): string | undefined {
  switch (refusal.code) {
    case "repoMount.rootResolutionFailed":
      return refusal.reason === "notARepository"
        ? "Couldn't attach · not a git repository"
        : undefined;
    case "repoMount.alreadyAttached":
      // A project's mount holding the repository names its project; only a chat's names none.
      return refusal.holder?.repoMountId !== undefined && refusal.holder.projectId === undefined
        ? `Couldn't attach · ${folder} is already attached to a chat`
        : undefined;
    default:
      return undefined;
  }
}
