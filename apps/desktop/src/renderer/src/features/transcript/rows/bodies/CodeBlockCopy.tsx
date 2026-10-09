import { CopyButton } from "#renderer/components/CopyButton/CopyButton.js";
import { useClipboardCopy } from "#renderer/services/platform/hooks/useClipboardCopy.js";

/** A code block's own Copy: it copies that block's source alone, as plain text. */
export function CodeBlockCopy(props: { readonly source: string }): React.JSX.Element {
  return <CopyButton label="Copy" clipboardCopy={useClipboardCopy({ text: props.source })} />;
}

/** Draws a reply's code block Copy, for the markdown render context. Module-scope, so stable. */
export function renderCodeBlockCopy(source: string): React.ReactNode {
  return <CodeBlockCopy source={source} />;
}
