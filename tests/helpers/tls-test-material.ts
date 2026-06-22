import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

/**
 * Generate a tiny self-signed certificate + key suitable for testing the
 * daemon HTTPS listeners. Uses the system `openssl` binary; tests that exercise
 * TLS-required code paths should skip themselves when openssl is unavailable.
 */
export async function generateSelfSignedPemForTests(): Promise<{
  cert: string;
  key: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "wos-tls-test-"));
  const certPath = resolve(dir, "cert.pem");
  const keyPath = resolve(dir, "key.pem");
  const configPath = resolve(dir, "req.cnf");
  const configBody = [
    "[req]",
    "distinguished_name = req_dn",
    "x509_extensions = v3_req",
    "prompt = no",
    "[req_dn]",
    "CN = localhost",
    "[v3_req]",
    "keyUsage = critical, digitalSignature, keyEncipherment",
    "extendedKeyUsage = serverAuth",
    "basicConstraints = critical, CA:FALSE",
    "subjectAltName = @alt_names",
    "[alt_names]",
    "DNS.1 = localhost",
    "IP.1 = 127.0.0.1",
    "",
  ].join("\n");
  await writeFile(configPath, configBody);
  await runOpenssl([
    "req",
    "-x509",
    "-nodes",
    "-newkey",
    "rsa:2048",
    "-days",
    "30",
    "-config",
    configPath,
    "-keyout",
    keyPath,
    "-out",
    certPath,
  ]);
  try {
    const cert = await readFile(certPath, "utf8");
    const key = await readFile(keyPath, "utf8");
    return { cert, key };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runOpenssl(args: string[]): Promise<void> {
  return new Promise((resolveProm, rejectProm) => {
    const child = spawn("openssl", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    child.on("error", (e: Error) => {
      rejectProm(new Error(`openssl unavailable: ${e.message}`));
    });
    child.on("close", (code: number | null) => {
      if (code === 0) return resolveProm();
      rejectProm(new Error(`openssl exited ${code ?? "?"}: ${stderr}`));
    });
  });
}
