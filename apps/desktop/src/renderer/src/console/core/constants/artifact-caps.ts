// The artifact pane's preview bound.

/**
 * Characters of a fetched artifact payload the pane will draw at once.
 *
 * A RENDERER bound and not a wire one, so it is picked here rather than mirrored
 * from a contract: an inline payload arrives whole and the pane has to decide how
 * much of it a person is shown before scrolling a hundred-megabyte log becomes the
 * surface's whole cost. Two thousand characters is a screenful and a half at the
 * console's mono measure — enough to recognise what a payload IS, which is what the
 * preview is for, and far short of the point where a single text node degrades
 * layout. Truncation is always reported beside the text; the preview never silently
 * shortens what it drew.
 */
export const ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP = 2_000;
