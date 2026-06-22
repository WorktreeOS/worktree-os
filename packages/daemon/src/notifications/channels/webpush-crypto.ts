import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign as cryptoSign,
} from "node:crypto";

/**
 * Native Web Push crypto for Bun: VAPID JWT signing (RFC 8292) and `aes128gcm`
 * content encryption (RFC 8291 / RFC 8188). Implemented on `node:crypto` so the
 * daemon needs no `web-push` dependency (see design.md spike outcome).
 */

export function base64UrlEncode(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}

export function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

export interface VapidKeys {
  /** Application server key: base64url uncompressed P-256 point (client side). */
  publicKey: string;
  /** Private key as a JWK, used for ES256 signing. */
  privateJwk: JsonWebKey;
}

/** Generate a fresh VAPID P-256 keypair. */
export function generateVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" }) as JsonWebKey;
  const x = base64UrlDecode(jwk.x as string);
  const y = base64UrlDecode(jwk.y as string);
  const uncompressed = Buffer.concat([Buffer.from([0x04]), x, y]);
  return { publicKey: base64UrlEncode(uncompressed), privateJwk: jwk };
}

export interface VapidJwtClaims {
  /** Origin of the push service endpoint (scheme + host). */
  aud: string;
  /** `mailto:` or `https:` contact subject. */
  sub: string;
  /** Expiry in seconds since epoch (≤ 24h out). */
  exp: number;
}

/** Sign a VAPID JWT (ES256, raw R‖S signature). */
export function signVapidJwt(privateJwk: JsonWebKey, claims: VapidJwtClaims): string {
  const header = base64UrlEncode(
    Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })),
  );
  const payload = base64UrlEncode(
    Buffer.from(
      JSON.stringify({ aud: claims.aud, exp: claims.exp, sub: claims.sub }),
    ),
  );
  const signingInput = `${header}.${payload}`;
  const key = createPrivateKey({ key: privateJwk, format: "jwk" });
  const signature = cryptoSign("sha256", Buffer.from(signingInput), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  return Buffer.from(hkdfSync("sha256", ikm, salt, info, length));
}

export interface EncryptInputs {
  /** Plaintext payload (typically JSON). */
  payload: string | Buffer;
  /** Subscriber public key: base64url uncompressed P-256 point. */
  uaPublicKey: string;
  /** Subscriber auth secret: base64url 16 bytes. */
  authSecret: string;
}

/**
 * Encrypt a payload to a subscriber's keys using `aes128gcm` (single record).
 * Returns the full message body (RFC 8188 header ‖ ciphertext) ready to POST.
 */
export function encryptPayload(inputs: EncryptInputs): Buffer {
  const plaintext = Buffer.isBuffer(inputs.payload)
    ? inputs.payload
    : Buffer.from(inputs.payload, "utf8");
  const uaPublic = base64UrlDecode(inputs.uaPublicKey);
  const authSecret = base64UrlDecode(inputs.authSecret);

  const local = createECDH("prime256v1");
  local.generateKeys();
  const asPublic = local.getPublicKey(); // 65-byte uncompressed point
  const sharedSecret = local.computeSecret(uaPublic);

  const salt = randomBytes(16);
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0"),
    uaPublic,
    asPublic,
  ]);
  const ikm = hkdf(authSecret, sharedSecret, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);

  // Single record: append the 0x02 last-record padding delimiter.
  const record = Buffer.concat([plaintext, Buffer.from([0x02])]);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(record),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const recordSize = 4096;
  const header = Buffer.alloc(16 + 4 + 1 + asPublic.length);
  salt.copy(header, 0);
  header.writeUInt32BE(recordSize, 16);
  header.writeUInt8(asPublic.length, 20);
  asPublic.copy(header, 21);

  return Buffer.concat([header, ciphertext]);
}
