import { CopyButton } from "#renderer/components/CopyButton/CopyButton.js";
import type { DiagramCopy } from "#renderer/components/Markdown/diagram/DiagramBlock.js";
import { useClipboardCopy } from "#renderer/services/platform/hooks/useClipboardCopy.js";

/** One of a diagram block's own copies, `Copy as picture` or `Copy source`, through main. */
export function DiagramBlockCopy(props: { readonly copy: DiagramCopy }): React.JSX.Element {
  return (
    <CopyButton label={props.copy.label} clipboardCopy={useClipboardCopy(props.copy.content)} />
  );
}

/** Draws a reply's diagram block copies, for the markdown render context. Module-scope: stable. */
export function renderDiagramBlockCopy(copy: DiagramCopy): React.ReactNode {
  return <DiagramBlockCopy copy={copy} />;
}
