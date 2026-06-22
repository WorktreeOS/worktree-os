import { test, expect, describe } from "bun:test";
import {
  PresenceRegistry,
  PRESENCE_TTL_MS,
} from "@worktreeos/daemon/notifications/presence";

describe("PresenceRegistry", () => {
  test("a focused report inserts the client as present", () => {
    const reg = new PresenceRegistry();
    expect(reg.hasFocusedClient(0)).toBe(false);
    reg.touch("c1", "focused", 0);
    expect(reg.hasFocusedClient(0)).toBe(true);
  });

  test("a refresh extends the expiry past the original TTL", () => {
    const reg = new PresenceRegistry();
    reg.touch("c1", "focused", 0);
    // Re-assert just before expiry; the entry should live a full TTL longer.
    reg.touch("c1", "focused", PRESENCE_TTL_MS - 1);
    expect(reg.hasFocusedClient(PRESENCE_TTL_MS + 1)).toBe(true);
    expect(reg.hasFocusedClient(2 * PRESENCE_TTL_MS)).toBe(false);
  });

  test("an away report removes the client immediately", () => {
    const reg = new PresenceRegistry();
    reg.touch("c1", "focused", 0);
    reg.touch("c1", "away", 1);
    expect(reg.hasFocusedClient(1)).toBe(false);
  });

  test("a lapsed heartbeat expires the client after the TTL", () => {
    const reg = new PresenceRegistry();
    reg.touch("c1", "focused", 0);
    expect(reg.hasFocusedClient(PRESENCE_TTL_MS - 1)).toBe(true);
    expect(reg.hasFocusedClient(PRESENCE_TTL_MS)).toBe(false);
  });

  test("presence is global across multiple clients", () => {
    const reg = new PresenceRegistry();
    reg.touch("c1", "focused", 0);
    reg.touch("c2", "focused", 0);
    // One client goes away, the other still holds presence.
    reg.touch("c1", "away", 1);
    expect(reg.hasFocusedClient(1)).toBe(true);
    reg.touch("c2", "away", 2);
    expect(reg.hasFocusedClient(2)).toBe(false);
  });

  test("an away report for an unknown client is a no-op", () => {
    const reg = new PresenceRegistry();
    reg.touch("ghost", "away", 0);
    expect(reg.hasFocusedClient(0)).toBe(false);
  });
});
