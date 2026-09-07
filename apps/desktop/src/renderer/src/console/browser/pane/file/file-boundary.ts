// The file boundary, on the renderer's side of it.
//
// `Spec-023 §Console Design (Meridian)` 12.5: "A `file:` destination is admitted only
// for a regular file whose fully resolved form is path-contained in an admitted root
// of a repo mount attached to this session … The refusal is the registered
// `repo.outside_trust_envelope` (403)."
//
// WHAT THIS MODULE IS AND IS NOT. It is not a containment check. Resolution is
// absolute, symlink-resolved, platform-normalized, component-boundary-aware and
// case-folded where the filesystem folds — and every one of those is a fact about a
// disk this process cannot see. 12.5 says so in its own Leverage note: the check is
// "the daemon's existing mount-envelope resolver, called rather than reimplemented; a
// second path-containment implementation is the defect this reuse exists to prevent."
// So the renderer does two things and neither of them is deciding:
//
//   • It DISCLOSES where files may come from, so a person composing a path is not
//     guessing. The disclosure is a read of the session's own workspaces, and it is
//     explicitly a description of the daemon's rule rather than a second copy of it —
//     a path inside a listed root can still be refused (a symlink out, a directory
//     rather than a regular file, a mount that has since detached), and the control's
//     copy says so.
//   • It RECOGNISES the boundary refusal when one comes back, so the sentence beside
//     it names the rule rather than leaving a bare 403 on screen.
//
// AND IT NEVER ECHOES THE PATH. The refusal renders the daemon's own message and the
// disclosure names roots the daemon reported; what the person typed stays in their
// field and goes nowhere else, which is the sanitization discipline the error
// contract states for this code.

import type { SessionId } from "@ai-sidekicks/contracts";
import { useEffect } from "react";

import { callDaemon, type ConsoleBridge } from "../../../bridge/index.js";
import type { ConsoleRefusal } from "../../../core/index.js";
import { useSubjectScopedState } from "../../../store/index.js";

/**
 * The registered code a destination outside the envelope is refused under.
 *
 * Spelled once, here, because two surfaces read it — the control that renders the
 * boundary sentence and the test that proves it does — and a second literal is a
 * second place for one registered string to be edited.
 */
export const OUTSIDE_TRUST_ENVELOPE_CODE = "repo.outside_trust_envelope";

/**
 * Whether a refusal IS the boundary refusal, wherever the code arrived on it.
 *
 * Two places, and both are checked. A refusal the port raised carries the code
 * itself; a refusal built from a REJECTED call carries the console's own
 * `call-rejected` and the daemon's word on `cause`, because the port's vocabulary
 * answers which seam broke and the cause answers what the other side said. Reading
 * only the first would render a generic failure for the one refusal in this surface
 * that has a sentence of its own.
 */
export function isOutsideTrustEnvelope(refusal: ConsoleRefusal | undefined): boolean {
  if (refusal === undefined) {
    return false;
  }
  if (refusal.code === OUTSIDE_TRUST_ENVELOPE_CODE) {
    return true;
  }
  const cause: unknown = (refusal as { readonly cause?: unknown }).cause;
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { readonly code?: unknown }).code === OUTSIDE_TRUST_ENVELOPE_CODE
  );
}

/**
 * Where this session's local files may come from, as far as the console can say.
 *
 * `unreportedWorkspaceCount` is carried rather than dropped: a workspace whose
 * filesystem root the daemon did not report is a place files may be admitted from
 * that this list does not name, and a disclosure that silently omitted it would read
 * as complete when it is not.
 */
export type AdmittedRootsReading =
  | { readonly kind: "reading" }
  | {
      readonly kind: "served";
      readonly roots: readonly string[];
      readonly unreportedWorkspaceCount: number;
    }
  | { readonly kind: "refused"; readonly refusal: ConsoleRefusal };

const UNREAD_ROOTS: AdmittedRootsReading = { kind: "reading" };

/**
 * Read the session's workspace roots, once per session.
 *
 * ONE REGISTERED READ AND NOT A SECOND FAMILY'S READER. Two other families read
 * workspaces for their own surfaces, and neither is reachable from here — every view
 * family is a sibling of every other — so this is the read this family makes, through
 * the same `callDaemon` chokepoint they use, with the parse, the refusal vocabulary
 * and the rejection normalizer all the bridge's rather than re-authored.
 *
 * A pane with no session reads nothing and says nothing, which is not a refusal: the
 * question was never put.
 */
export function useAdmittedRoots(
  bridge: ConsoleBridge,
  sessionId: string | undefined,
): AdmittedRootsReading {
  const { value: reading, publish } = useSubjectScopedState(
    bridge,
    sessionId ?? "",
    () => UNREAD_ROOTS,
  );

  useEffect(() => {
    if (sessionId === undefined) {
      return;
    }
    let cancelled = false;
    void (async () => {
      // NO `catch` HERE, AND THAT IS THE POINT. `callDaemon` is total by construction
      // and by its own documented claim — every throw site inside it sits in its own
      // `try` — so a `catch` around this call could only ever run if that seam broke
      // its contract, and the refusal code it would have to mint for that case is a
      // code no test could reach and no person could ever see. `reply.status ===
      // "refused"` is the one refusal path, which is what the eleven other console
      // callers of this seam already assume by carrying no `catch` at all.
      //
      // The console never MINTS a session id; it forwards the one it was given, and
      // the brand is a compile-time marker over the same opaque string.
      const reply = await callDaemon(bridge, "repo.workspaceList", {
        sessionId: sessionId as SessionId,
      });
      if (cancelled) {
        return;
      }
      if (reply.status === "refused") {
        publish({ kind: "refused", refusal: reply.refusal });
        return;
      }
      const roots = reply.value.workspaces
        .map((workspace) => workspace.fsRoot)
        .filter((root): root is string => root !== undefined && root.length > 0);
      publish({
        kind: "served",
        roots,
        unreportedWorkspaceCount: reply.value.workspaces.length - roots.length,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [bridge, publish, sessionId]);

  return reading;
}
