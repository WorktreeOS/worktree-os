import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildTunnelSanInputs,
  buildWebSanInputs,
  certsDir,
  generatedCertPaths,
  resolveSslMaterial,
} from "@worktreeos/daemon/ssl-resolver";

let tmpHome: string;
const env = () => ({ WOS_HOME: tmpHome }) as NodeJS.ProcessEnv;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "wos-ssl-resolve-"));
});

afterEach(async () => {
  await rm(tmpHome, { recursive: true, force: true });
});

describe("resolveSslMaterial — configured paths", () => {
  test("reads configured cert and key files", async () => {
    const certPath = resolve(tmpHome, "web.crt");
    const keyPath = resolve(tmpHome, "web.key");
    await writeFile(certPath, "CERT-BODY");
    await writeFile(keyPath, "KEY-BODY");

    const result = await resolveSslMaterial({
      ssl: { enabled: true, source: "files", cert: certPath, key: keyPath },
      kind: "web",
      env: env(),
    });
    expect(result.cert).toBe("CERT-BODY");
    expect(result.key).toBe("KEY-BODY");
    expect(result.certPath).toBe(certPath);
    expect(result.keyPath).toBe(keyPath);
    expect(result.generated).toBe(false);
  });

  test("missing configured cert file throws actionable error", async () => {
    await expect(
      resolveSslMaterial({
        ssl: { enabled: true, source: "files", cert: "/no/such/cert.pem", key: "/no/such/key.pem" },
        kind: "web",
        env: env(),
      }),
    ).rejects.toThrow(/web.ssl.cert/);
  });
});

describe("resolveSslMaterial — generated self-signed", () => {
  test("generates persistent files at stable paths", async () => {
    const expectedPaths = generatedCertPaths("web", env());
    let calls = 0;
    const result = await resolveSslMaterial({
      ssl: { enabled: true, source: "self-signed" },
      kind: "web",
      env: env(),
      sanDns: ["localhost"],
      sanIp: ["127.0.0.1"],
      generateSelfSigned: async (input) => {
        calls += 1;
        expect(input.commonName).toBe("localhost");
        expect(input.sanDns).toEqual(["localhost"]);
        expect(input.sanIp).toEqual(["127.0.0.1"]);
        return { cert: "GEN-CERT", key: "GEN-KEY" };
      },
    });

    expect(calls).toBe(1);
    expect(result.generated).toBe(true);
    expect(result.cert).toBe("GEN-CERT");
    expect(result.key).toBe("GEN-KEY");
    expect(result.certPath).toBe(expectedPaths.cert);
    expect(result.keyPath).toBe(expectedPaths.key);
    expect(existsSync(expectedPaths.cert)).toBe(true);
    expect(existsSync(expectedPaths.key)).toBe(true);
    expect(await readFile(expectedPaths.cert, "utf8")).toBe("GEN-CERT");
  });

  test("reuses generated files on subsequent calls", async () => {
    let calls = 0;
    const generator = async () => {
      calls += 1;
      return { cert: "CERT-1", key: "KEY-1" };
    };
    const first = await resolveSslMaterial({
      ssl: { enabled: true, source: "self-signed" },
      kind: "tunnel",
      env: env(),
      generateSelfSigned: generator,
      sanDns: ["example.com"],
    });
    expect(first.generated).toBe(true);
    expect(calls).toBe(1);

    const second = await resolveSslMaterial({
      ssl: { enabled: true, source: "self-signed" },
      kind: "tunnel",
      env: env(),
      generateSelfSigned: generator,
      sanDns: ["example.com"],
    });
    expect(calls).toBe(1);
    expect(second.certPath).toBe(first.certPath);
    expect(second.cert).toBe("CERT-1");
  });

  test("generator failure surfaces an actionable error", async () => {
    await expect(
      resolveSslMaterial({
        ssl: { enabled: true, source: "self-signed" },
        kind: "web",
        env: env(),
        generateSelfSigned: async () => {
          throw new Error("openssl: unavailable");
        },
      }),
    ).rejects.toThrow(/web SSL self-signed certificate generation failed/);
  });
});

describe("certsDir and SAN builders", () => {
  test("certsDir is <wos-home>/certs", () => {
    expect(certsDir(env())).toBe(resolve(tmpHome, "certs"));
  });

  test("buildWebSanInputs includes localhost, loopbacks, and public hostname", () => {
    const { sanDns, sanIp } = buildWebSanInputs({
      publicHostname: "wos.example.com",
    });
    expect(sanDns).toContain("localhost");
    expect(sanDns).toContain("wos.example.com");
    expect(sanIp).toEqual(["127.0.0.1", "::1"]);
  });

  test("buildWebSanInputs without public hostname stays loopback-only", () => {
    const { sanDns } = buildWebSanInputs({});
    expect(sanDns).toEqual(["localhost"]);
  });

  test("buildTunnelSanInputs includes domain and wildcard", () => {
    const { sanDns } = buildTunnelSanInputs({ tunnelDomain: "example.com" });
    expect(sanDns).toEqual(["example.com", "*.example.com"]);
  });
});
