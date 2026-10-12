// A diff drawn outside a window still needs the window's alignment worker, so a suite that mounts
// one directly wraps it in a provider of its own.

import type { ReactNode } from "react";

import { AlignmentWorkerProvider } from "#renderer/features/repos/index.js";

/** `Wrapper` with an alignment worker inside it, for a suite that draws a diff. */
export function withAlignmentWorker(
  Wrapper: (props: { readonly children: ReactNode }) => React.JSX.Element,
): (props: { readonly children: ReactNode }) => React.JSX.Element {
  return function WrapperWithAlignmentWorker(props: {
    readonly children: ReactNode;
  }): React.JSX.Element {
    return (
      <Wrapper>
        <AlignmentWorkerProvider>{props.children}</AlignmentWorkerProvider>
      </Wrapper>
    );
  };
}
