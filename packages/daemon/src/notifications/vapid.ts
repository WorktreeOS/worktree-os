import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { wosHome } from "@worktreeos/core/paths";
import { generateVapidKeys, type VapidKeys } from "./channels/webpush-crypto";

export const VAPID_FILENAME = "vapid.json";

/** Path to the persisted VAPID keypair (`<wos-home>/vapid.json`). */
export function vapidKeysPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(wosHome(env), VAPID_FILENAME);
}

/**
 * Load the persisted VAPID keypair, generating and persisting one on first use.
 * The file is written with owner-only permissions because it holds the private
 * signing key. A corrupt/partial file is regenerated.
 */
export async function loadOrCreateVapidKeys(
  path: string = vapidKeysPath(),
): Promise<VapidKeys> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as VapidKeys).publicKey === "string" &&
      (parsed as VapidKeys).privateJwk
    ) {
      return {
        publicKey: (parsed as VapidKeys).publicKey,
        privateJwk: (parsed as VapidKeys).privateJwk,
      };
    }
  } catch {
    // Absent or corrupt — fall through to regenerate.
  }
  const keys = generateVapidKeys();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(keys, null, 2) + "\n", "utf8");
  try {
    await chmod(path, 0o600);
  } catch {
    // Best-effort: some filesystems ignore POSIX perms.
  }
  return keys;
}
