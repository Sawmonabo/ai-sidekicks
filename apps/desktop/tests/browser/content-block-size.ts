// A box's height inside its block padding, for the cases that measure one box against
// the room another gives it. Several containers pad themselves to leave room for the
// browser's focus mark, so what each hands the box inside it is this, not its outer height.

export function contentBlockSize(element: HTMLElement): number {
  const style = getComputedStyle(element);
  return (
    element.getBoundingClientRect().height -
    Number.parseFloat(style.paddingBlockStart) -
    Number.parseFloat(style.paddingBlockEnd)
  );
}
