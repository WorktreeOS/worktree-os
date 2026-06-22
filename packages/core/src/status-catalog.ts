import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { wosHome } from "./paths";

export const STATUSES_FILENAME = "statuses.json";

/**
 * Maximum number of characters permitted in a workflow status name. Status
 * names are short labels (a word or two); the limit keeps stored metadata
 * bounded and column headers compact.
 */
export const STATUS_NAME_MAX_LENGTH = 60;

/**
 * A single freeform workflow status in the global catalog. `id` is stable for
 * the life of the status; `order` defines column order (lowest first) and is
 * normalized to a dense 0..n-1 range after every mutation.
 */
export interface WorkflowStatus {
  id: string;
  name: string;
  /** Hex color (`#rgb` or `#rrggbb`). */
  color: string;
  order: number;
}

export interface StatusCatalogFile {
  version: 1;
  statuses: WorkflowStatus[];
}

export class StatusCatalogError extends Error {}

/**
 * Preset statuses seeded the first time the catalog is read. Colors are
 * deliberately non-amber: amber is reserved for `/slash-command` prefixes in
 * the web UI, so workflow statuses avoid it to prevent visual collision.
 */
export const PRESET_STATUSES: ReadonlyArray<Omit<WorkflowStatus, "order">> = [
  { id: "to-dev", name: "to dev", color: "#6b7280" },
  { id: "develop", name: "develop", color: "#3b82f6" },
  { id: "review", name: "review", color: "#8b5cf6" },
  { id: "to-merge", name: "to merge", color: "#06b6d4" },
  { id: "merged", name: "merged", color: "#10b981" },
];

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export interface StatusFieldValidationOk {
  ok: true;
  value: string;
}
export interface StatusFieldValidationError {
  ok: false;
  message: string;
}
export type StatusFieldValidation =
  | StatusFieldValidationOk
  | StatusFieldValidationError;

/** Validate a status name: trimmed, non-empty, bounded, no control chars. */
export function validateStatusName(raw: unknown): StatusFieldValidation {
  if (typeof raw !== "string") {
    return { ok: false, message: "status name must be a string" };
  }
  const value = raw.trim();
  if (value.length === 0) {
    return { ok: false, message: "status name must not be empty" };
  }
  if (value.length > STATUS_NAME_MAX_LENGTH) {
    return {
      ok: false,
      message: `status name must be at most ${STATUS_NAME_MAX_LENGTH} characters`,
    };
  }
  if (/[\x00-\x1f\x7f]/.test(value)) {
    return {
      ok: false,
      message: "status name must not contain control characters",
    };
  }
  return { ok: true, value };
}

/** Validate a status color: a 3- or 6-digit hex string. Normalized to lowercase. */
export function validateStatusColor(raw: unknown): StatusFieldValidation {
  if (typeof raw !== "string") {
    return { ok: false, message: "status color must be a string" };
  }
  const value = raw.trim();
  if (!HEX_COLOR.test(value)) {
    return {
      ok: false,
      message: "status color must be a hex color like #8B5CF6",
    };
  }
  return { ok: true, value: value.toLowerCase() };
}

export function statusesFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(wosHome(env), STATUSES_FILENAME);
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** Derive a stable, catalog-unique id from a status name. */
function deriveStatusId(name: string, taken: ReadonlySet<string>): string {
  const base = slugify(name) || "status";
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

/** Sort statuses by order then reassign a dense 0..n-1 order. Mutates copies. */
function normalizeOrders(statuses: WorkflowStatus[]): WorkflowStatus[] {
  return [...statuses]
    .sort((a, b) => a.order - b.order)
    .map((s, i) => ({ ...s, order: i }));
}

function seededCatalog(): StatusCatalogFile {
  return {
    version: 1,
    statuses: PRESET_STATUSES.map((s, i) => ({ ...s, order: i })),
  };
}

export interface LoadOptions {
  env?: NodeJS.ProcessEnv;
  filePath?: string;
}

/**
 * Load the global status catalog. When no `statuses.json` exists, the catalog
 * is seeded with the preset statuses and persisted before being returned.
 */
export async function loadStatusCatalog(
  opts: LoadOptions = {},
): Promise<StatusCatalogFile> {
  const path = opts.filePath ?? statusesFilePath(opts.env);
  const file = Bun.file(path);
  if (!(await file.exists())) {
    const seeded = seededCatalog();
    await saveStatusCatalog(seeded, opts);
    return seeded;
  }
  let parsed: unknown;
  try {
    parsed = await file.json();
  } catch (e) {
    throw new StatusCatalogError(
      `failed to parse ${path}: ${(e as Error).message}`,
    );
  }
  return { version: 1, statuses: sanitizeStatuses(parsed) };
}

function sanitizeStatuses(parsed: unknown): WorkflowStatus[] {
  if (!parsed || typeof parsed !== "object") return [];
  const root = parsed as Partial<StatusCatalogFile>;
  if (!Array.isArray(root.statuses)) return [];
  const out: WorkflowStatus[] = [];
  const taken = new Set<string>();
  for (const raw of root.statuses) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Partial<WorkflowStatus>;
    if (typeof r.id !== "string" || r.id.length === 0) continue;
    if (taken.has(r.id)) continue;
    const name = validateStatusName(r.name);
    if (!name.ok) continue;
    const color = validateStatusColor(r.color);
    if (!color.ok) continue;
    taken.add(r.id);
    out.push({
      id: r.id,
      name: name.value,
      color: color.value,
      order: typeof r.order === "number" && Number.isFinite(r.order) ? r.order : out.length,
    });
  }
  return normalizeOrders(out);
}

export async function saveStatusCatalog(
  catalog: StatusCatalogFile,
  opts: LoadOptions = {},
): Promise<void> {
  const path = opts.filePath ?? statusesFilePath(opts.env);
  await mkdir(dirname(path), { recursive: true });
  const payload: StatusCatalogFile = {
    version: 1,
    statuses: normalizeOrders(catalog.statuses),
  };
  await Bun.write(path, JSON.stringify(payload, null, 2) + "\n");
}

export interface StatusMutationResult {
  catalog: StatusCatalogFile;
  status: WorkflowStatus;
}

/** Append a new status to the end of the catalog. */
export async function createStatus(
  name: string,
  color: string,
  opts: LoadOptions = {},
): Promise<StatusMutationResult> {
  const nameValidation = validateStatusName(name);
  if (!nameValidation.ok) throw new StatusCatalogError(nameValidation.message);
  const colorValidation = validateStatusColor(color);
  if (!colorValidation.ok) throw new StatusCatalogError(colorValidation.message);
  const catalog = await loadStatusCatalog(opts);
  const taken = new Set(catalog.statuses.map((s) => s.id));
  const status: WorkflowStatus = {
    id: deriveStatusId(nameValidation.value, taken),
    name: nameValidation.value,
    color: colorValidation.value,
    order: catalog.statuses.length,
  };
  const next: StatusCatalogFile = {
    version: 1,
    statuses: normalizeOrders([...catalog.statuses, status]),
  };
  await saveStatusCatalog(next, opts);
  const saved = next.statuses.find((s) => s.id === status.id)!;
  return { catalog: next, status: saved };
}

export interface StatusUpdate {
  name?: string;
  color?: string;
  /** Desired column index; the status is moved to this position. */
  order?: number;
}

/**
 * Update a status's name, color, and/or order. Preserves the status id (and
 * therefore all worktree assignments to it). Returns `null` when no status
 * with the given id exists.
 */
export async function updateStatus(
  id: string,
  update: StatusUpdate,
  opts: LoadOptions = {},
): Promise<StatusMutationResult | null> {
  const catalog = await loadStatusCatalog(opts);
  const idx = catalog.statuses.findIndex((s) => s.id === id);
  if (idx < 0) return null;
  const existing = catalog.statuses[idx]!;
  const updated: WorkflowStatus = { ...existing };
  if (update.name !== undefined) {
    const v = validateStatusName(update.name);
    if (!v.ok) throw new StatusCatalogError(v.message);
    updated.name = v.value;
  }
  if (update.color !== undefined) {
    const v = validateStatusColor(update.color);
    if (!v.ok) throw new StatusCatalogError(v.message);
    updated.color = v.value;
  }
  if (update.order !== undefined) {
    if (typeof update.order !== "number" || !Number.isFinite(update.order)) {
      throw new StatusCatalogError("status order must be a finite number");
    }
    // Place just before the target index by sorting on a fractional order.
    updated.order = update.order - 0.5;
  }
  const nextStatuses = [...catalog.statuses];
  nextStatuses[idx] = updated;
  const next: StatusCatalogFile = {
    version: 1,
    statuses: normalizeOrders(nextStatuses),
  };
  await saveStatusCatalog(next, opts);
  const saved = next.statuses.find((s) => s.id === id)!;
  return { catalog: next, status: saved };
}

/**
 * Delete a status from the catalog. Returns the updated catalog, or `null` when
 * no status with the given id exists. Worktree reassignment to "no status" is
 * handled separately by the board store (`reassignStatusToUnassigned`).
 */
export async function deleteStatus(
  id: string,
  opts: LoadOptions = {},
): Promise<StatusCatalogFile | null> {
  const catalog = await loadStatusCatalog(opts);
  if (!catalog.statuses.some((s) => s.id === id)) return null;
  const next: StatusCatalogFile = {
    version: 1,
    statuses: normalizeOrders(catalog.statuses.filter((s) => s.id !== id)),
  };
  await saveStatusCatalog(next, opts);
  return next;
}
