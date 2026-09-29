// The push contract: a machine hands the control plane one sealed notice for one of
// the person's devices, and the control plane delivers it through the person's own
// APNs, FCM or VAPID credentials.
//
// The machine seals every notice to the device's own push key before it leaves, so
// the control plane and the push services carry bytes they cannot open, and the
// control plane stores nothing about a notice.
import { z } from "zod";

import { EmptyAcknowledgementSchema, type EmptyAcknowledgement } from "./device.js";
import { decodedByteLength } from "./internal/base64.js";
import { defineMethodDescriptors, type MethodDescriptor } from "./method-descriptor.js";
import { DeviceIdSchema, type DeviceId } from "./trust-statement.js";

/** The most sealed bytes one push carries: every platform's 4 KB payload limit. */
export const PUSH_SEALED_NOTICE_MAX_BYTES = 4096;

/**
 * How soon the push service delivers it. `Waiting on you` and a workflow's Notify
 * step go at `high`; `Finished` and `Failed` at `normal`.
 */
export const PUSH_URGENCIES = ["high", "normal"] as const;
/** One push urgency. */
export type PushUrgency = (typeof PUSH_URGENCIES)[number];

/**
 * One sealed push. `collapseId` is derived from the moment's stable id, so a later
 * notice for the same moment replaces the earlier one in place; it fits Web Push's
 * `Topic` header, the tightest of the three platforms' limits (32 base64url
 * characters). Every push expires 24 hours after its moment.
 */
export interface PushSendRequest {
  deviceId: DeviceId;
  sealed: string;
  collapseId: string;
  urgency: PushUrgency;
  expiresAt: string;
}
/** Parses a {@link PushSendRequest}. */
export const PushSendRequestSchema: z.ZodType<PushSendRequest, PushSendRequest> = z
  .object({
    deviceId: DeviceIdSchema,
    sealed: z
      .base64()
      .min(1)
      .refine(
        (value) => decodedByteLength(value) <= PUSH_SEALED_NOTICE_MAX_BYTES,
        `a sealed notice is at most ${PUSH_SEALED_NOTICE_MAX_BYTES} bytes`,
      ),
    collapseId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,32}$/u, "a collapse id is 1 to 32 base64url characters"),
    urgency: z.enum(PUSH_URGENCIES),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();

/** The push procedure the control plane serves. */
export interface PushProcedureDescriptors {
  readonly "push.send": MethodDescriptor<"push.send", PushSendRequest, EmptyAcknowledgement>;
}

/** The push procedure the control plane serves. */
export const PUSH_PROCEDURE_DESCRIPTORS: PushProcedureDescriptors = defineMethodDescriptors({
  "push.send": {
    method: "push.send",
    procedureType: "mutation",
    mutating: true,
    requestSchema: PushSendRequestSchema,
    responseSchema: EmptyAcknowledgementSchema,
  },
});
