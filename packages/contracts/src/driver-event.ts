// `driver.subscribeEvents` streams one run's driver activity: the session events of six
// categories. A separate module because `event.ts` reads `provider-driver.ts` values at module
// scope, so importing `event.ts` from `provider-driver.ts` would close an eager cycle that fails
// at runtime as an `undefined` schema.
//
// `DRIVER_EVENT_TYPES` covers every type the six categories carry, including one with no payload
// variant, because the filter decides what belongs on the stream, not what parses. `DriverEvent`
// covers only the registered variants, a subset, which is what `DriverEventSchema`'s cast rests on.

import { z } from "zod";

import {
  ARTIFACT_PUBLICATION_EVENT_TYPES,
  ASSISTANT_OUTPUT_EVENT_TYPES,
  INTERACTIVE_REQUEST_EVENT_TYPES,
  RUN_LIFECYCLE_EVENT_TYPES,
  TOOL_ACTIVITY_EVENT_TYPES,
  USAGE_TELEMETRY_EVENT_TYPES,
  type SessionEventType,
} from "./event-registry.js";
import { SessionEventSchema } from "./event.js";
import type { SessionEvent } from "./event-variant-types.js";
import { SubscribeAckResponseSchema, type SubscribeAckResponse } from "./jsonrpc-streaming.js";
import { defineMethodDescriptors, type SubscriptionMethodDescriptor } from "./method-descriptor.js";
import {
  DriverSubscribeEventsParamsSchema,
  type DriverSubscribeEventsParams,
} from "./provider-driver-wire.js";

// The six categories a driver event may carry; everything below derives from this choice.
type DriverEventCategory =
  | "run_lifecycle"
  | "assistant_output"
  | "tool_activity"
  | "interactive_request"
  | "artifact_publication"
  | "usage_telemetry";

/**
 * Every `SessionEventType` in the six driver-event categories: the membership test a
 * driver-event stream filters on. Spread from the per-category arrays, so a new event type in
 * a category joins the set automatically.
 */
export const DRIVER_EVENT_TYPES: ReadonlySet<SessionEventType> = new Set<SessionEventType>([
  ...RUN_LIFECYCLE_EVENT_TYPES,
  ...ASSISTANT_OUTPUT_EVENT_TYPES,
  ...TOOL_ACTIVITY_EVENT_TYPES,
  ...INTERACTIVE_REQUEST_EVENT_TYPES,
  ...ARTIFACT_PUBLICATION_EVENT_TYPES,
  ...USAGE_TELEMETRY_EVENT_TYPES,
]);

/**
 * The `SessionEvent` arms a `driver.subscribeEvents` stream may deliver. Derived from each
 * variant's literal `category`, because the per-category arrays are annotated with the whole
 * `SessionEventType` and derive nothing.
 */
export type DriverEvent = Extract<SessionEvent, { category: DriverEventCategory }>;

/**
 * The `type` discriminant of {@link DriverEvent}.
 *
 * @consumedBy the client SDK's stream of one run's driver activity
 */
export type DriverEventType = DriverEvent["type"];

/**
 * `SessionEventSchema` narrowed to the driver-event categories: it refuses an event whose `type`
 * is outside {@link DRIVER_EVENT_TYPES}. It refines rather than rebuilds, so output equals input.
 */
export const DriverEventSchema: z.ZodType<DriverEvent> = SessionEventSchema.superRefine(
  (event, ctx) => {
    if (DRIVER_EVENT_TYPES.has(event.type)) return;
    ctx.addIssue({
      code: "custom",
      path: ["type"],
      message:
        `Event type '${event.type}' is outside the driver event ` +
        `categories and cannot travel on a driver event stream.`,
    });
  },
) as z.ZodType<DriverEvent>;

/** `driver.subscribeEvents`: one run's driver activity, as a stream of driver events. */
export interface DriverEventMethodDescriptors {
  readonly "driver.subscribeEvents": SubscriptionMethodDescriptor<
    "driver.subscribeEvents",
    DriverSubscribeEventsParams,
    SubscribeAckResponse,
    DriverEvent
  >;
}

/**
 * The driver event stream's method. It sits here rather than in the driver
 * method table because its emission is the session event, which the driver
 * contract cannot import.
 */
export const DRIVER_EVENT_METHOD_DESCRIPTORS: DriverEventMethodDescriptors =
  defineMethodDescriptors({
    "driver.subscribeEvents": {
      method: "driver.subscribeEvents",
      procedureType: "subscription",
      mutating: false,
      requestSchema: DriverSubscribeEventsParamsSchema,
      responseSchema: SubscribeAckResponseSchema,
      emissionSchema: DriverEventSchema,
    },
  });
