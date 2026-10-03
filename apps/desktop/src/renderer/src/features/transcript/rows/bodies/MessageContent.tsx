// The agent's reply: its body read by the media type its producer declared, then by its bytes.

import { useCallback } from "react";

import { MachineBody, type MachineBodyProps } from "./MachineBody.js";
import { outputKindOf, type OutputKind } from "./output-kinds.js";

/** What the reply's body is drawn from. */
export interface MessageContentProps extends Omit<MachineBodyProps, "readOutputKind"> {
  /**
   * The media type the producer declared (`AssistantOutputPayload.contentType`), a
   * free-form wire string.
   */
  readonly contentType?: string | undefined;
}

/** The agent's reply: markdown, plain text or command output, by its declared type. */
export function MessageContent(props: MessageContentProps): React.JSX.Element {
  const { contentType, ...bodyProps } = props;
  const readOutputKind = useCallback(
    (body: string): OutputKind => outputKindOf(body, contentType),
    [contentType],
  );
  return <MachineBody {...bodyProps} readOutputKind={readOutputKind} />;
}
