/**
 * Minimal Cloudflare DNS Records API adapter used by the Let's Encrypt DNS-01
 * challenge runner. Wraps the v4 API endpoints we need (zone lookup, TXT
 * record create/list/delete) and normalises Cloudflare's response envelope
 * (`{ success, errors, result }`) into thrown errors with actionable messages.
 *
 * Tests inject `fetchImpl` to avoid real network calls.
 */

export interface CloudflareApiError {
  code: number;
  message: string;
}

export interface CloudflareTxtRecord {
  id: string;
  name: string;
  content: string;
}

export interface CloudflareClient {
  /** Look up a zone by exact name. Returns `undefined` when not found. */
  findZoneByName(name: string): Promise<string | undefined>;
  /** Create a TXT record. Returns the new record id. */
  createTxtRecord(
    zoneId: string,
    name: string,
    content: string,
    ttl?: number,
  ): Promise<string>;
  /** List TXT records matching `name` (exact). */
  listTxtRecords(zoneId: string, name: string): Promise<CloudflareTxtRecord[]>;
  /** Delete a record id. */
  deleteRecord(zoneId: string, recordId: string): Promise<void>;
}

export interface CloudflareClientOptions {
  apiToken: string;
  /** Override the base URL (tests, alternate endpoints). */
  baseUrl?: string;
  /** Inject a `fetch` implementation for tests. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.cloudflare.com/client/v4";

export function createCloudflareClient(
  opts: CloudflareClientOptions,
): CloudflareClient {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = opts.fetchImpl ?? fetch;

  async function call<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts.apiToken}`,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(
        `Cloudflare API request failed (${method} ${path}): ${(e as Error).message}`,
      );
    }
    let envelope: {
      success?: boolean;
      errors?: CloudflareApiError[];
      result?: T;
    };
    try {
      envelope = await response.json();
    } catch (e) {
      throw new Error(
        `Cloudflare API returned non-JSON response (${response.status} ${method} ${path}): ${(e as Error).message}`,
      );
    }
    if (!response.ok || envelope.success === false) {
      const first = envelope.errors?.[0];
      const detail = first
        ? `code=${first.code} ${first.message}`
        : `HTTP ${response.status}`;
      throw new Error(
        `Cloudflare API error (${method} ${path}): ${detail}`,
      );
    }
    return envelope.result as T;
  }

  return {
    async findZoneByName(name) {
      const zones = await call<Array<{ id: string; name: string }>>(
        "GET",
        `/zones?name=${encodeURIComponent(name)}`,
      );
      const match = zones.find((z) => z.name === name);
      return match?.id;
    },
    async createTxtRecord(zoneId, name, content, ttl = 60) {
      const record = await call<{ id: string }>(
        "POST",
        `/zones/${encodeURIComponent(zoneId)}/dns_records`,
        { type: "TXT", name, content, ttl, proxied: false },
      );
      return record.id;
    },
    async listTxtRecords(zoneId, name) {
      const records = await call<CloudflareTxtRecord[]>(
        "GET",
        `/zones/${encodeURIComponent(zoneId)}/dns_records?type=TXT&name=${encodeURIComponent(name)}`,
      );
      return records;
    },
    async deleteRecord(zoneId, recordId) {
      await call<{ id: string }>(
        "DELETE",
        `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
      );
    },
  };
}
