import {
  useChannelActivity,
  type ActivityIndicatorRegistry,
  type ChannelActivityLabels,
} from "../activity-model.js";
import { AgentActivityLine } from "./AgentActivityLine.js";

/**
 * The row's live indicator, subscribed rather than read once.
 *
 * Its own component so the subscription is scoped to the row: a run starting in one
 * channel re-renders that row's line and leaves every other row's alone, which is what
 * keeps a busy session from re-rendering the whole list on each transition.
 */
export function ChannelRowActivity(props: {
  readonly activity: ActivityIndicatorRegistry;
  readonly channelId: string;
  readonly labels: ChannelActivityLabels;
}): React.JSX.Element | null {
  const activity = useChannelActivity(props.activity, props.channelId);
  return <AgentActivityLine activity={activity} labels={props.labels} />;
}
