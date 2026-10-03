// The device contract is the boundary between the person's devices, the control plane and each
// machine's service. These tests hold its security edges: a list event named for another
// statement, a short linking proof, a push key or Web Push endpoint the control plane cannot
// safely send to, and a forwarded call to a procedure the service does not carry.
import { describe, expect, it } from "vitest";

import {
  ControlPlaneCallRequestSchema,
  DeviceLinkRedeemRequestSchema,
  DeviceListEventSchema,
  DeviceNotificationSettingsSetRequestSchema,
  DevicePushAddressSetRequestSchema,
} from "../device.js";
import { base64Bytes, P256_KEY } from "./trust-statement.test-support.js";

const HASH = "a".repeat(64);
const ISSUED_AT = "2026-09-12T10:00:00.000Z";
const DEVICE_ID = "device-phone-1";
const CHANNEL_KEY = { algorithm: "x25519", publicKey: base64Bytes(32) } as const;
const DEVICE_SIGNATURE = { signer: "device", deviceId: DEVICE_ID, signature: base64Bytes(64) };

const deviceRenamed = {
  kind: "device.renamed",
  previousHash: HASH,
  issuedAt: ISSUED_AT,
  signatures: [DEVICE_SIGNATURE],
  deviceId: DEVICE_ID,
  name: "Work phone",
};
describe("device.list", () => {
  it("names a statement event by its statement's kind", () => {
    expect(
      DeviceListEventSchema.safeParse({ type: "device.renamed", statement: deviceRenamed }).success,
    ).toBe(true);
    expect(
      DeviceListEventSchema.safeParse({ type: "device.revoked", statement: deviceRenamed }).success,
    ).toBe(false);
  });
});

describe("linking", () => {
  const redeem = {
    pairingId: "pairing-1",
    identityKey: P256_KEY,
    channelKey: CHANNEL_KEY,
    name: "iPhone",
    platform: "iPhone",
    appVersion: "1.4.0",
    mac: base64Bytes(32),
  };

  it("accepts the new device's half of the link", () => {
    expect(DeviceLinkRedeemRequestSchema.safeParse(redeem).success).toBe(true);
  });

  it("refuses a linking proof that is not a SHA-256 HMAC", () => {
    expect(
      DeviceLinkRedeemRequestSchema.safeParse({ ...redeem, mac: base64Bytes(16) }).success,
    ).toBe(false);
  });
});

describe("push address and notification switches", () => {
  it("accepts each platform's address", () => {
    expect(
      DevicePushAddressSetRequestSchema.safeParse({ platform: "apns", address: "ab".repeat(32) })
        .success,
    ).toBe(true);
    expect(
      DevicePushAddressSetRequestSchema.safeParse({
        platform: "webPush",
        address: "https://web.push.apple.com/QGuQyavXutnMH",
      }).success,
    ).toBe(true);
  });

  it("refuses a Web Push endpoint that is not https", () => {
    expect(
      DevicePushAddressSetRequestSchema.safeParse({
        platform: "webPush",
        address: "http://169.254.169.254/latest",
      }).success,
    ).toBe(false);
  });

  const settings = {
    notifyOutsideTheApp: true,
    countOnAppIcon: true,
    kinds: { waitingOnYou: true, finished: true, failed: false, notifyStep: true },
    pushKey: base64Bytes(1216),
  };

  it("accepts a phone's switches and a browser's subscription keys", () => {
    expect(DeviceNotificationSettingsSetRequestSchema.safeParse(settings).success).toBe(true);
    expect(
      DeviceNotificationSettingsSetRequestSchema.safeParse({
        ...settings,
        webPushKeys: {
          p256dh: Buffer.alloc(65, 4).toString("base64url"),
          auth: Buffer.alloc(16, 5).toString("base64url"),
        },
      }).success,
    ).toBe(true);
  });

  it("refuses a push key that is not an X-Wing public key", () => {
    expect(
      DeviceNotificationSettingsSetRequestSchema.safeParse({
        ...settings,
        pushKey: base64Bytes(32),
      }).success,
    ).toBe(false);
  });
});

describe("controlPlane.call", () => {
  it("forwards a listed procedure", () => {
    expect(
      ControlPlaneCallRequestSchema.safeParse({
        procedure: "device.rename",
        input: { statement: deviceRenamed },
      }).success,
    ).toBe(true);
  });

  it("refuses a procedure the service does not carry", () => {
    for (const procedure of [
      "runtimenode.register",
      "runtimenode.certificateChallengeSet",
      "push.send",
    ]) {
      expect(ControlPlaneCallRequestSchema.safeParse({ procedure, input: {} }).success).toBe(false);
    }
  });
});
