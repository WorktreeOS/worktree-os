import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  createDecipheriv,
  createECDH,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import {
  base64UrlEncode,
  encryptPayload,
  generateVapidKeys,
  signVapidJwt,
} from "@worktreeos/daemon/notifications/channels/webpush-crypto";
import {
  loadOrCreateVapidKeys,
  vapidKeysPath,
} from "@worktreeos/daemon/notifications/vapid";
import {
  parsePushSubscriptionInput,
  removeSubscription,
  upsertSubscription,
} from "@worktreeos/daemon/notifications/subscriptions";
import {
  WebPushChannel,
  type PushRequest,
} from "@worktreeos/daemon/notifications/channels/webpush";
import {
  defaultNotificationsConfig,
  type Notification,
  type PushSubscription,
} from "@worktreeos/core/notifications";

const notification: Notification = {
  kind: "agent.question",
  title: "Agent needs input · feature-x",
  body: "Approve edit?",
  severity: "needs-attention",
  link: "/worktree?path=%2Fwt%2Ffeature-x",
  dedupeKey: "agent.question:sess-1:t",
};

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, len: number): Buffer {
  return Buffer.from(hkdfSync("sha256", ikm, salt, info, len));
}

/** A synthetic browser subscriber for the encryption round-trip. */
function makeSubscriber() {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const auth = randomBytes(16);
  return {
    ecdh: ua,
    p256dh: base64UrlEncode(ua.getPublicKey()),
    auth: base64UrlEncode(auth),
  };
}

function decrypt(body: Buffer, ua: ReturnType<typeof createECDH>, authB64: string): string {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const shared = ua.computeSecret(asPublic);
  const uaPublic = ua.getPublicKey();
  const auth = Buffer.from(authB64, "base64url");
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = hkdf(auth, shared, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const ct = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  // Strip the trailing 0x02 last-record delimiter.
  return plain.subarray(0, plain.length - 1).toString("utf8");
}

describe("webpush crypto", () => {
  test("encrypted payload round-trips to the subscriber", () => {
    const subscriber = makeSubscriber();
    const body = encryptPayload({
      payload: "hello push",
      uaPublicKey: subscriber.p256dh,
      authSecret: subscriber.auth,
    });
    expect(decrypt(body, subscriber.ecdh, subscriber.auth)).toBe("hello push");
  });

  test("VAPID JWT has three segments and the alg header", () => {
    const keys = generateVapidKeys();
    const jwt = signVapidJwt(keys.privateJwk, {
      aud: "https://push.example",
      sub: "mailto:dev@example.com",
      exp: 1_000_000,
    });
    const segments = jwt.split(".");
    expect(segments).toHaveLength(3);
    const header = JSON.parse(Buffer.from(segments[0]!, "base64url").toString());
    expect(header.alg).toBe("ES256");
  });
});

describe("vapid persistence", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "wos-vapid-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("generates once and reuses on the next load", async () => {
    const path = vapidKeysPath({ WOS_HOME: dir } as NodeJS.ProcessEnv);
    const first = await loadOrCreateVapidKeys(path);
    const second = await loadOrCreateVapidKeys(path);
    expect(second.publicKey).toBe(first.publicKey);
    if (process.platform !== "win32") {
      const mode = (await stat(path)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });
});

describe("subscription store helpers", () => {
  const subA: PushSubscription = { endpoint: "https://p/a", keys: { p256dh: "a", auth: "a" } };
  const subB: PushSubscription = { endpoint: "https://p/b", keys: { p256dh: "b", auth: "b" } };

  test("upsert adds and replaces by endpoint", () => {
    let list = upsertSubscription([], subA);
    list = upsertSubscription(list, subB);
    expect(list).toHaveLength(2);
    const replaced = { ...subA, keys: { p256dh: "a2", auth: "a2" } };
    list = upsertSubscription(list, replaced);
    expect(list).toHaveLength(2);
    expect(list.find((s) => s.endpoint === "https://p/a")?.keys.p256dh).toBe("a2");
  });

  test("remove drops by endpoint", () => {
    const list = removeSubscription([subA, subB], "https://p/a");
    expect(list.map((s) => s.endpoint)).toEqual(["https://p/b"]);
  });

  test("parse rejects malformed input and accepts a valid subscription", () => {
    expect(parsePushSubscriptionInput(null)).toBeNull();
    expect(parsePushSubscriptionInput({ endpoint: "x" })).toBeNull();
    expect(
      parsePushSubscriptionInput({ endpoint: "https://p/a", keys: { p256dh: "p", auth: "a" } }),
    ).toEqual({ endpoint: "https://p/a", keys: { p256dh: "p", auth: "a" } });
  });
});

describe("WebPushChannel fan-out", () => {
  function configWith(enabled: boolean, subs: PushSubscription[]) {
    const cfg = defaultNotificationsConfig();
    cfg.channels.webpush = { enabled };
    cfg.pushSubscriptions = subs;
    return cfg;
  }

  test("delivers to each subscription and prunes gone ones", async () => {
    const subscriberA = makeSubscriber();
    const subscriberB = makeSubscriber();
    const subA: PushSubscription = {
      endpoint: "https://push.example/A",
      keys: { p256dh: subscriberA.p256dh, auth: subscriberA.auth },
    };
    const subB: PushSubscription = {
      endpoint: "https://push.example/B",
      keys: { p256dh: subscriberB.p256dh, auth: subscriberB.auth },
    };
    const requests: PushRequest[] = [];
    const gone: string[] = [];
    const channel = new WebPushChannel({
      vapid: generateVapidKeys(),
      subject: "mailto:dev@example.com",
      onSubscriptionGone: (endpoint) => gone.push(endpoint),
      sender: async (req) => {
        requests.push(req);
        return { status: req.endpoint.endsWith("/B") ? 410 : 201 };
      },
    });
    channel.updateConfig(configWith(true, [subA, subB]));
    const result = await channel.send(notification);

    expect(requests).toHaveLength(2);
    expect(result.ok).toBe(true); // A succeeded
    expect(gone).toEqual(["https://push.example/B"]);
    // The encrypted body for A decrypts to the carried payload.
    const reqA = requests.find((r) => r.endpoint.endsWith("/A"))!;
    expect(reqA.headers["content-encoding"]).toBe("aes128gcm");
    expect(reqA.headers.authorization).toContain("vapid t=");
    const decoded = JSON.parse(decrypt(reqA.body, subscriberA.ecdh, subscriberA.auth));
    expect(decoded.title).toBe(notification.title);
    expect(decoded.data.path).toBe(notification.link);
  });

  test("validateConfig is false with no subscriptions", () => {
    const channel = new WebPushChannel({
      vapid: generateVapidKeys(),
      subject: "mailto:dev@example.com",
    });
    channel.updateConfig(configWith(true, []));
    expect(channel.validateConfig().ok).toBe(false);
  });
});
