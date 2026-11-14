// The chat's `Attach a repo` flow in the composer card: one line saying what will happen, a typed
// path the daemon checks, and `Cancel` beside `Convert to project`. A refusal stands under the
// field; a conversion closes the form, and the session's own listing then reads as a project.

import { useState } from "react";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import type { ExtendedRefusal } from "#renderer/lib/refusal/extensions.js";
import { callDaemon } from "#renderer/services/daemon/reply.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";

/** What the form converts and how it closes. */
export interface ConvertToProjectFormProps {
  readonly bridge: PlatformBridge;
  readonly sessionId: SessionId;
  readonly onClose: () => void;
}

/** The convert form, empty when it opens. */
export function ConvertToProjectForm(props: ConvertToProjectFormProps): React.JSX.Element {
  const [path, setPath] = useState("");
  const [refusal, setRefusal] = useState<ExtendedRefusal | undefined>(undefined);
  const [isConverting, setIsConverting] = useState(false);
  // One key per opened form, so a repeated press is one conversion.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  return (
    <form
      className="meridian-composer-convert"
      onSubmit={(event) => {
        event.preventDefault();
        setIsConverting(true);
        void callDaemon(props.bridge, "session.convert", {
          sessionId: props.sessionId,
          path,
          clientIdempotencyKey: idempotencyKey,
        }).then((reply) => {
          setIsConverting(false);
          if (reply.status === "refused") {
            setRefusal(reply.refusal);
            return;
          }
          props.onClose();
        });
      }}
    >
      <p className="meridian-composer-convert__line">Copies chat files to the repo</p>
      <input
        className="meridian-composer-convert__path"
        aria-label="Repository folder"
        value={path}
        onChange={(event) => {
          setPath(event.target.value);
        }}
      />
      {refusal === undefined ? null : <InlineRefusal code={refusal.code} detail={refusal.detail} />}
      <button type="button" className="meridian-clickable-word" onClick={props.onClose}>
        Cancel
      </button>
      <button
        type="submit"
        className="meridian-clickable-word"
        disabled={isConverting || path.trim().length === 0}
      >
        Convert to project
      </button>
    </form>
  );
}
