// The daemon's diff read as the model the pane renders. Each wire file carries its own patch, so
// the path, rename, binary, unreadable and step facts are taken from the wire file and only the
// hunks (and a declared mode change) from its parsed patch.

import type {
  DiffFile as WireDiffFile,
  GitflowDiffReadResponse,
} from "@ai-sidekicks/contracts/gitflow/local";

import type { DiffFile, DiffModel } from "./model.js";
import { parseUnifiedPatch, type ComparedStates } from "./patch-parse.js";

/** The model one `gitflow.diffRead` reply draws, its two ends named as the daemon named them. */
export function diffModelFromRead(response: GitflowDiffReadResponse): DiffModel {
  const comparedStates: ComparedStates = { baseRef: response.base, headRef: response.head };
  return {
    ...comparedStates,
    files: response.files.map((file) => diffFileFromWire(file, comparedStates)),
  };
}

function diffFileFromWire(file: WireDiffFile, comparedStates: ComparedStates): DiffFile {
  const parsed =
    file.patch === undefined ? undefined : parseUnifiedPatch(file.patch, comparedStates).files[0];
  return {
    path: file.path,
    ...(file.oldPath === undefined ? {} : { renamedFrom: file.oldPath }),
    ...(parsed?.modeChange === undefined ? {} : { modeChange: parsed.modeChange }),
    ...(file.binary === true ? { binary: true } : {}),
    ...(file.unreadable === undefined ? {} : { unreadable: file.unreadable }),
    ...(file.step === undefined ? {} : { stepName: file.step.nodeName }),
    ...(file.patch === undefined ? {} : { patch: file.patch }),
    hunks: parsed?.hunks ?? [],
  };
}
