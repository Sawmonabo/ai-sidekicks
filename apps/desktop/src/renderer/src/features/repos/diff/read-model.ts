// The daemon's diff read as the model the pane renders. Each wire file carries its own patch, so
// the path, kind, mode, binary, unreadable and step facts are taken from the wire file, which
// states them for a file with no patch too, and only the hunks from its parsed patch.

import type {
  DiffFile as WireDiffFile,
  GitflowDiffReadResponse,
} from "@ai-sidekicks/contracts/gitflow/local";

import type { DiffFile, DiffFileChange, DiffModel } from "./model.js";
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
    change: changeOf(file),
    ...(file.modeChanged === true ? { modeChanged: true } : {}),
    ...(file.binary === true ? { binary: true } : {}),
    ...(file.unreadable === undefined ? {} : { unreadable: file.unreadable }),
    ...(file.step === undefined ? {} : { stepName: file.step.nodeName }),
    ...(file.patch === undefined ? {} : { patch: file.patch }),
    hunks: parsed?.hunks ?? [],
  };
}

/** The wire file's kind, with the path a rename came from, which the wire sends exactly then. */
function changeOf(file: WireDiffFile): DiffFileChange {
  if (file.kind !== "renamed") {
    return { kind: file.kind };
  }
  if (file.oldPath === undefined) {
    throw new Error(`The daemon named ${file.path} renamed with no path it came from.`);
  }
  return { kind: "renamed", renamedFrom: file.oldPath };
}
