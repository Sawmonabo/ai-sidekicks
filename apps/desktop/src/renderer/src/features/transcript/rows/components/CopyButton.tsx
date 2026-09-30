import { useClipboardCopy, type ClipboardCopyStatus } from "../hooks/useClipboardCopy.js";

const COPY_LABELS: Readonly<Record<ClipboardCopyStatus, string>> = {
  rest: "Copy",
  copied: "Copied",
  failed: "Could not copy",
};

/** What one Copy control puts on the clipboard. */
export interface CopyButtonProps {
  /** What a press puts on the clipboard, exactly as given. */
  readonly text: string;
}

/**
 * A message's Copy control. The outcome is reported on the control itself and nowhere
 * else, then the control returns to rest.
 */
export function CopyButton(props: CopyButtonProps): React.JSX.Element {
  const { status, copy } = useClipboardCopy(props.text);
  return (
    <button type="button" className="meridian-disclosure-trigger" onClick={copy}>
      {COPY_LABELS[status]}
    </button>
  );
}
