import { test, expect, describe } from "bun:test";
import {
  toStoredSubscription,
  urlBase64ToUint8Array,
} from "./push-subscribe";

describe("urlBase64ToUint8Array", () => {
  test("decodes a base64url string with url-safe chars and missing padding", () => {
    // "ab-_" base64url → bytes; verify length and round-trip of a known value.
    const out = urlBase64ToUint8Array("aGVsbG8"); // "hello" without padding
    expect(Buffer.from(out).toString("utf8")).toBe("hello");
  });

  test("handles url-safe alphabet (- and _)", () => {
    const standard = "+/+/"; // maps from "-_-_" in url-safe
    const fromUrlSafe = urlBase64ToUint8Array("-_-_");
    const expected = Uint8Array.from(atob(standard), (c) => c.charCodeAt(0));
    expect(Array.from(fromUrlSafe)).toEqual(Array.from(expected));
  });
});

describe("toStoredSubscription", () => {
  test("shapes a complete subscription", () => {
    const json: PushSubscriptionJSON = {
      endpoint: "https://push.example/x",
      expirationTime: 123,
      keys: { p256dh: "p", auth: "a" },
    };
    expect(toStoredSubscription(json)).toEqual({
      endpoint: "https://push.example/x",
      keys: { p256dh: "p", auth: "a" },
      expirationTime: 123,
    });
  });

  test("omits a null expirationTime", () => {
    const json: PushSubscriptionJSON = {
      endpoint: "https://push.example/x",
      expirationTime: null,
      keys: { p256dh: "p", auth: "a" },
    };
    expect(toStoredSubscription(json)).toEqual({
      endpoint: "https://push.example/x",
      keys: { p256dh: "p", auth: "a" },
    });
  });

  test("returns null when keys are missing", () => {
    expect(
      toStoredSubscription({ endpoint: "https://x", keys: {} } as PushSubscriptionJSON),
    ).toBeNull();
    expect(toStoredSubscription({ keys: { p256dh: "p", auth: "a" } } as PushSubscriptionJSON)).toBeNull();
  });
});
