import { type SidebarSectionContext } from "../../seats/index.js";
import { Nothing } from "../../primitives/index.js";
import { useSessionModels, type CollaborationSessionModelHolder } from "../session-models.js";
import { MembersSectionBody } from "./MembersSectionBody.js";

export interface MembersSectionProps {
  readonly context: SidebarSectionContext;
  readonly holder: CollaborationSessionModelHolder;
  /**
   * The reader's own participant id, when the mount knows it.
   *
   * Marked rather than moved: the reader's row stays where their presence state puts
   * it, because a roster that hoisted one row would stop being ordered by the thing
   * its ordering claims to mean.
   */
  readonly selfParticipantId?: string | undefined;
}

export function MembersSection(props: MembersSectionProps): React.JSX.Element {
  const { context, holder, selfParticipantId } = props;
  const models = useSessionModels(holder, context.bridge, context.sessionStore);
  if (models === undefined) {
    return <Nothing kind="not-loaded" placement="surface" title="Opening this session's room." />;
  }
  return (
    <MembersSectionBody context={context} models={models} selfParticipantId={selfParticipantId} />
  );
}
