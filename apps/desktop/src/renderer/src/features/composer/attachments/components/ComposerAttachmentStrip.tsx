// The composer's attachment strip over its staging: files dropped or pasted over the composer
// upload here, and the strip shows them only while something is staged or dragged over it.

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import type { ComposerHeldDraft } from "../../held-draft/holder.js";
import { AttachmentStrip } from "../AttachmentStrip.js";
import { useComposerStaging } from "../hooks/useComposerStaging.js";

/** What the strip stages for: the session, the composer region and the held draft it hands to. */
export interface ComposerAttachmentStripProps {
  readonly bridge: PlatformBridge;
  readonly sessionId: SessionId;
  readonly region: React.RefObject<HTMLElement | null>;
  readonly heldDraft: ComposerHeldDraft;
}

/** Stage files over the composer and draw them while they upload. */
export function ComposerAttachmentStrip(
  props: ComposerAttachmentStripProps,
): React.JSX.Element | null {
  const { stagedAttachments, isDraggingFiles } = useComposerStaging(
    props.bridge,
    props.sessionId,
    props.region,
    props.heldDraft,
  );
  return (
    <AttachmentStrip stagedAttachments={stagedAttachments} isDraggingFiles={isDraggingFiles} />
  );
}
