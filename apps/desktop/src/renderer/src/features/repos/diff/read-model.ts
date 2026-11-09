// The daemon's two diff reads as the model the views render. Review's read carries each file's
// patch with its facts, so the path, kind, mode, binary, unreadable and step facts are taken from
// the wire file, which states them for a file with no patch too, and only the hunks from its
// parsed patch. A tool call's left-out patches come paged, a file's patch or raw text split where
// a page ends, and each file names a move by its old path and says why it has no patch to draw.

import type {
  DiffFile as WireDiffFile,
  GitDiffReadResponse,
} from "@ai-sidekicks/contracts/git/local";
import type {
  TranscriptPatchFile,
  TranscriptPatchListResponse,
} from "@ai-sidekicks/contracts/transcript/operations";

import type { DiffFile, DiffFileChange, DiffModel } from "./model.js";
import { parseUnifiedPatch, type ComparedStates } from "./patch-parse.js";

/** The model one `git.diff.read` reply draws, its two ends named as the daemon named them. */
export function diffModelFromRead(response: GitDiffReadResponse): DiffModel {
  const comparedStates: ComparedStates = { baseRef: response.base, headRef: response.head };
  return {
    ...comparedStates,
    files: response.files.map((file) => diffFileFromWire(file, comparedStates)),
  };
}

/**
 * The model a tool call's left-out patches draw, from the `transcript.patch.list` pages read from
 * the call's first file on, in order. A page the one before ended inside a file (its `next` offset
 * past zero) opens with the rest of that file's patch or raw text. Throws where such a page opens
 * with a file of another arm, which no daemon sends.
 *
 * @consumedBy the transcript's diff card, once it reads a call's left-out patches
 */
export function diffModelFromPatchList(
  pages: readonly TranscriptPatchListResponse[],
  comparedStates: ComparedStates,
): DiffModel {
  return {
    ...comparedStates,
    files: joinedPatchFiles(pages).map((file) => diffFileFromPatchFile(file, comparedStates)),
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
  return file.kind === "renamed"
    ? { kind: "renamed", renamedFrom: file.oldPath }
    : { kind: file.kind };
}

/** Each file of the pages once, its pieces split across a page end joined in order. */
function joinedPatchFiles(pages: readonly TranscriptPatchListResponse[]): TranscriptPatchFile[] {
  const files: TranscriptPatchFile[] = [];
  let opensInsideFile = false;
  for (const page of pages) {
    page.files.forEach((file, fileIndex) => {
      const continued = files.at(-1);
      if (fileIndex === 0 && opensInsideFile && continued !== undefined) {
        files[files.length - 1] = withRestOf(continued, file);
      } else {
        files.push(file);
      }
    });
    opensInsideFile = page.next !== null && page.next.offset > 0;
  }
  return files;
}

/** One file's text so far followed by the piece the next page carries. */
function withRestOf(file: TranscriptPatchFile, rest: TranscriptPatchFile): TranscriptPatchFile {
  if (file.unavailable === undefined && rest.unavailable === undefined) {
    return { ...file, patch: file.patch + rest.patch };
  }
  if (file.unavailable === "unreadable" && rest.unavailable === "unreadable") {
    return { ...file, rawPatch: file.rawPatch + rest.rawPatch };
  }
  throw new Error(`The patch list continued ${file.path} with a file of another kind.`);
}

/**
 * One left-out patch as the model draws it. A moved file is named by its new path and its change
 * by its old one; an empty patch has no lines and nothing to copy.
 */
function diffFileFromPatchFile(
  file: TranscriptPatchFile,
  comparedStates: ComparedStates,
): DiffFile {
  const moved: DiffFileChange | undefined =
    file.oldPath === undefined ? undefined : { kind: "renamed", renamedFrom: file.oldPath };
  if (file.unavailable === undefined) {
    const parsed =
      file.patch === "" ? undefined : parseUnifiedPatch(file.patch, comparedStates).files[0];
    return {
      path: file.path,
      change: moved ?? parsed?.change ?? { kind: "modified" },
      ...(parsed?.modeChanged === true ? { modeChanged: true } : {}),
      ...(parsed?.binary === true ? { binary: true } : {}),
      ...(file.patch === "" ? {} : { patch: file.patch }),
      hunks: parsed?.hunks ?? [],
    };
  }
  return {
    path: file.path,
    change: moved ?? { kind: "modified" },
    patchUnavailable:
      file.unavailable === "unreadable"
        ? { reason: "unreadable", rawPatch: file.rawPatch }
        : { reason: file.unavailable },
    hunks: [],
  };
}
