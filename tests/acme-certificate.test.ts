import { test, expect, describe } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  parseCertificate,
  coversHostnames,
  evaluateRenewal,
  hostnameCovered,
} from "@worktreeos/daemon/acme/certificate";

/**
 * Generate a self-signed certificate PEM via the system openssl binary so we
 * can exercise the real X509Certificate parser. Returns the PEM body.
 */
function makeCert(
  cn: string,
  altNames: string[],
  days = 30,
): string {
  const id = randomBytes(6).toString("hex");
  const cfgPath = join(tmpdir(), `acme-cert-${id}.cnf`);
  const keyPath = join(tmpdir(), `acme-cert-${id}.key`);
  const certPath = join(tmpdir(), `acme-cert-${id}.crt`);
  const sanLines = altNames.map((n, i) => `DNS.${i + 1} = ${n}`).join("\n");
  const cfg = [
    "[req]",
    "distinguished_name = req_dn",
    "x509_extensions = v3_req",
    "prompt = no",
    "",
    "[req_dn]",
    `CN = ${cn}`,
    "",
    "[v3_req]",
    "basicConstraints = critical, CA:FALSE",
    "keyUsage = critical, digitalSignature, keyEncipherment",
    "extendedKeyUsage = serverAuth",
    altNames.length > 0 ? "subjectAltName = @alt_names" : "",
    "",
    altNames.length > 0 ? "[alt_names]" : "",
    sanLines,
    "",
  ].join("\n");
  writeFileSync(cfgPath, cfg);
  const r = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-nodes",
      "-newkey",
      "rsa:2048",
      "-days",
      String(days),
      "-config",
      cfgPath,
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    throw new Error(`openssl failed: ${r.stderr || r.stdout}`);
  }
  const pem = readFileSync(certPath, "utf8");
  try { unlinkSync(cfgPath); unlinkSync(keyPath); unlinkSync(certPath); } catch {}
  return pem;
}

describe("parseCertificate", () => {
  test("extracts CN and SAN hostnames", () => {
    const pem = makeCert("primary.example.com", [
      "primary.example.com",
      "alt.example.com",
      "*.example.com",
    ]);
    const parsed = parseCertificate(pem);
    expect(parsed.hostnames).toContain("primary.example.com");
    expect(parsed.hostnames).toContain("alt.example.com");
    expect(parsed.hostnames).toContain("*.example.com");
    expect(parsed.notBefore.getTime()).toBeLessThanOrEqual(Date.now());
    expect(parsed.notAfter.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("hostnameCovered", () => {
  test("exact match", () => {
    expect(hostnameCovered(["example.com"], "example.com")).toBe(true);
  });
  test("wildcard covers single-level subdomain", () => {
    expect(hostnameCovered(["*.example.com"], "foo.example.com")).toBe(true);
  });
  test("wildcard does not cover apex", () => {
    expect(hostnameCovered(["*.example.com"], "example.com")).toBe(false);
  });
  test("wildcard does not cover two-level subdomain", () => {
    expect(hostnameCovered(["*.example.com"], "a.b.example.com")).toBe(false);
  });
});

describe("coversHostnames", () => {
  test("returns true when all required are covered", () => {
    const pem = makeCert("example.com", ["example.com", "*.example.com"]);
    const parsed = parseCertificate(pem);
    expect(coversHostnames(parsed, ["example.com", "foo.example.com"])).toBe(true);
  });
  test("returns false when one required hostname is missing", () => {
    const pem = makeCert("example.com", ["example.com"]);
    const parsed = parseCertificate(pem);
    expect(coversHostnames(parsed, ["example.com", "other.com"])).toBe(false);
  });
});

describe("evaluateRenewal", () => {
  test("shouldRenew false for fresh cert", () => {
    const pem = makeCert("example.com", ["example.com"], 90);
    const r = evaluateRenewal(parseCertificate(pem));
    expect(r.shouldRenew).toBe(false);
    expect(r.active).toBe(true);
  });

  test("shouldRenew true inside 30-day window", () => {
    const pem = makeCert("example.com", ["example.com"], 20);
    const r = evaluateRenewal(parseCertificate(pem));
    expect(r.shouldRenew).toBe(true);
    expect(r.daysUntilExpiry).toBeLessThan(30);
  });

  test("expired flag set when past notAfter", () => {
    const pem = makeCert("example.com", ["example.com"], 30);
    const parsed = parseCertificate(pem);
    const future = new Date(parsed.notAfter.getTime() + 60_000);
    const r = evaluateRenewal(parsed, { now: future });
    expect(r.expired).toBe(true);
    expect(r.active).toBe(false);
    expect(r.shouldRenew).toBe(true);
  });
});
