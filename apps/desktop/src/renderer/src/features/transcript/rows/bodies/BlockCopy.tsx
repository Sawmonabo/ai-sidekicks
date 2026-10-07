import { CopyButton } from "#renderer/components/CopyButton/CopyButton.js";
import type { BlockCopyOffer } from "#renderer/components/Markdown/block-copy-offer.js";
import { useClipboardCopy } from "#renderer/services/platform/hooks/useClipboardCopy.js";

/** One of a markdown block's own copies, such as a code block's `Copy`, written through main. */
export function BlockCopy(props: { readonly offer: BlockCopyOffer }): React.JSX.Element {
  return (
    <CopyButton label={props.offer.label} clipboardCopy={useClipboardCopy(props.offer.content)} />
  );
}

/** Draws a reply's block copies, for the markdown render context. Module-scope, so stable. */
export function renderBlockCopy(offer: BlockCopyOffer): React.ReactNode {
  return <BlockCopy offer={offer} />;
}
