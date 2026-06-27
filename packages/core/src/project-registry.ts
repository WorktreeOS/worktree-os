import { mkdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, basename, resolve } from "node:path";
import { wosHome } from "./paths";

export const PROJECTS_FILENAME = "projects.json";

export interface ProjectRecord {
  id: string;
  /** Display name shown in UI lists. Defaults to basename of source path. */
  displayName: string;
  /** Normalized absolute path to the primary/source worktree. */
  sourcePath: string;
  /** ISO timestamp when this entry was first added. */
  createdAt: string;
  /** ISO timestamp when this entry was last touched (e.g. after `up`). */
  lastSeenAt: string;
  /** Optional last validation error (e.g. path missing, not a worktree). */
  lastError?: string;
  /**
   * Palette slot index in [0, PROJECT_PALETTE_SIZE) selecting the project's
   * identity color. Assigned round-robin by least-used slot on registration,
   * user-overridable, and stable thereafter. Backfilled deterministically for
   * legacy records that predate this field.
   */
  colorSlot?: number;
  /**
   * Display order across projects. Normalized to a dense 0..n-1 range after
   * every mutation; lowest renders first. Backfilled for legacy records.
   */
  order?: number;
  /**
   * Optional display-only names for individual worktrees, keyed by the
   * normalized absolute worktree path. Used by the UI to render a stable
   * human-readable label without affecting Git or session identity.
   */
  worktreeDisplayNames?: Record<string, string>;
  /**
   * Optional free-form notes for individual worktrees, keyed by the normalized
   * absolute worktree path. Used by the UI to render a short human-authored
   * note without affecting Git or session identity.
   */
  worktreeNotes?: Record<string, string>;
  /**
   * Optional manual, timestamped comments for individual worktrees, keyed by
   * the normalized absolute worktree path. Treats a worktree as a lightweight
   * task; entries are append/delete only and never affect Git or session
   * identity.
   */
  worktreeComments?: Record<string, WorktreeComment[]>;
}

/** A single manual comment on a worktree. */
export interface WorktreeComment {
  /** Stable id for deletion. */
  id: string;
  /** Comment body. */
  text: string;
  /** ISO timestamp when the comment was created. */
  createdAt: string;
}

/**
 * Number of curated identity-color slots in the project palette. Must equal the
 * count of `--p-*` tokens defined in `apps/web/src/index.css`.
 */
export const PROJECT_PALETTE_SIZE = 36;

/**
 * Maximum number of characters permitted in a project display name. Mirrors the
 * worktree display-name bound; keeps stored metadata bounded and rail labels
 * compact.
 */
export const PROJECT_DISPLAY_NAME_MAX_LENGTH = 120;

/**
 * Validate a project display name: trimmed, non-empty, bounded, and free of
 * NUL/control characters. Same rules as a worktree display name.
 */
export function validateProjectDisplayName(
  raw: unknown,
): WorktreeDisplayNameValidation {
  if (typeof raw !== "string") {
    return { ok: false, message: "display name must be a string" };
  }
  const value = raw.trim();
  if (value.length === 0) {
    return { ok: false, message: "display name must not be empty" };
  }
  if (value.length > PROJECT_DISPLAY_NAME_MAX_LENGTH) {
    return {
      ok: false,
      message: `display name must be at most ${PROJECT_DISPLAY_NAME_MAX_LENGTH} characters`,
    };
  }
  if (/[\x00-\x1f\x7f]/.test(value)) {
    return {
      ok: false,
      message: "display name must not contain control characters",
    };
  }
  return { ok: true, value };
}

/**
 * Maximum number of characters permitted in a worktree display name. The
 * limit keeps stored metadata bounded and avoids unbounded rendering in
 * compact UI surfaces like the sidebar.
 */
export const WORKTREE_DISPLAY_NAME_MAX_LENGTH = 120;

/**
 * Maximum number of characters permitted in a worktree note. A note may be a
 * sentence or two; the limit keeps stored metadata bounded.
 */
export const WORKTREE_NOTE_MAX_LENGTH = 1000;

/**
 * Maximum number of characters permitted in a single worktree comment. Keeps
 * stored metadata bounded; a comment is expected to be a short remark.
 */
export const WORKTREE_COMMENT_MAX_LENGTH = 2000;

export interface WorktreeDisplayNameValidationOk {
  ok: true;
  /** Trimmed, validated value safe to persist. */
  value: string;
}

export interface WorktreeDisplayNameValidationError {
  ok: false;
  message: string;
}

export type WorktreeDisplayNameValidation =
  | WorktreeDisplayNameValidationOk
  | WorktreeDisplayNameValidationError;

/**
 * Validate a worktree display name. Display names are presentation metadata
 * only — they may include spaces and common punctuation but must be trimmed,
 * non-empty, bounded, and free of NUL/control characters.
 */
export function validateWorktreeDisplayName(
  raw: unknown,
): WorktreeDisplayNameValidation {
  if (typeof raw !== "string") {
    return { ok: false, message: "display name must be a string" };
  }
  const value = raw.trim();
  if (value.length === 0) {
    return { ok: false, message: "display name must not be empty" };
  }
  if (value.length > WORKTREE_DISPLAY_NAME_MAX_LENGTH) {
    return {
      ok: false,
      message: `display name must be at most ${WORKTREE_DISPLAY_NAME_MAX_LENGTH} characters`,
    };
  }
  if (/[\x00-\x1f\x7f]/.test(value)) {
    return {
      ok: false,
      message: "display name must not contain control characters",
    };
  }
  return { ok: true, value };
}

export interface WorktreeNoteValidationOk {
  ok: true;
  /** Trimmed, validated value safe to persist. Empty string means "clear". */
  value: string;
}

export interface WorktreeNoteValidationError {
  ok: false;
  message: string;
}

export type WorktreeNoteValidation =
  | WorktreeNoteValidationOk
  | WorktreeNoteValidationError;

/**
 * Validate a worktree note. Notes are free-form presentation metadata: they
 * may include spaces, newlines, and tabs, but must be bounded and free of
 * NUL/other control characters. An empty/whitespace-only note is valid and
 * means "clear the stored note".
 */
export function validateWorktreeNote(raw: unknown): WorktreeNoteValidation {
  if (typeof raw !== "string") {
    return { ok: false, message: "note must be a string" };
  }
  const value = raw.trim();
  if (value.length > WORKTREE_NOTE_MAX_LENGTH) {
    return {
      ok: false,
      message: `note must be at most ${WORKTREE_NOTE_MAX_LENGTH} characters`,
    };
  }
  // Allow newline (\n), carriage return (\r), and tab (\t); reject other
  // control characters.
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    return {
      ok: false,
      message: "note must not contain control characters",
    };
  }
  return { ok: true, value };
}

export interface WorktreeCommentValidationOk {
  ok: true;
  /** Trimmed, validated comment text safe to persist. */
  value: string;
}

export interface WorktreeCommentValidationError {
  ok: false;
  message: string;
}

export type WorktreeCommentValidation =
  | WorktreeCommentValidationOk
  | WorktreeCommentValidationError;

/**
 * Validate a worktree comment. Comments are free-form manual text: they may
 * include spaces, newlines, and tabs, but must be non-empty after trimming,
 * bounded, and free of other control characters.
 */
export function validateWorktreeComment(
  raw: unknown,
): WorktreeCommentValidation {
  if (typeof raw !== "string") {
    return { ok: false, message: "comment must be a string" };
  }
  const value = raw.trim();
  if (value.length === 0) {
    return { ok: false, message: "comment must not be empty" };
  }
  if (value.length > WORKTREE_COMMENT_MAX_LENGTH) {
    return {
      ok: false,
      message: `comment must be at most ${WORKTREE_COMMENT_MAX_LENGTH} characters`,
    };
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    return { ok: false, message: "comment must not contain control characters" };
  }
  return { ok: true, value };
}

export interface ProjectsFile {
  version: 1;
  projects: ProjectRecord[];
}

export class ProjectRegistryError extends Error {}

export function projectsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(wosHome(env), PROJECTS_FILENAME);
}

export function normalizeSourcePath(p: string): string {
  const absolute = resolve(p);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

export function defaultDisplayName(sourcePath: string): string {
  const name = basename(sourcePath);
  return name.length > 0 ? name : sourcePath;
}

export interface LoadOptions {
  env?: NodeJS.ProcessEnv;
  filePath?: string;
}

/** Whether a value is a valid palette slot index in [0, PROJECT_PALETTE_SIZE). */
function isValidColorSlot(slot: unknown): slot is number {
  return (
    typeof slot === "number" &&
    Number.isInteger(slot) &&
    slot >= 0 &&
    slot < PROJECT_PALETTE_SIZE
  );
}

/**
 * Pick the least-used palette slot across the given records, breaking ties by
 * the lowest slot index. Records without a valid slot are ignored. With at most
 * PROJECT_PALETTE_SIZE distinct slots in use this returns an unused slot; beyond
 * that it returns the least-repeated one, so colors only repeat once exhausted.
 */
export function assignProjectColorSlot(
  projects: ReadonlyArray<Pick<ProjectRecord, "colorSlot">>,
): number {
  const counts = new Array<number>(PROJECT_PALETTE_SIZE).fill(0);
  for (const p of projects) {
    if (isValidColorSlot(p.colorSlot)) {
      counts[p.colorSlot] = (counts[p.colorSlot] ?? 0) + 1;
    }
  }
  let best = 0;
  for (let i = 1; i < PROJECT_PALETTE_SIZE; i++) {
    if (counts[i]! < counts[best]!) best = i;
  }
  return best;
}

/**
 * Re-sort projects by effective display order and reassign a dense 0..n-1
 * `order`. Records with a numeric `order` sort first by that value; records
 * without one keep their incoming (file) order after them. Stable.
 */
function normalizeProjectsOrder(projects: ProjectRecord[]): ProjectRecord[] {
  return projects
    .map((p, index) => ({
      p,
      key:
        typeof p.order === "number" && Number.isFinite(p.order)
          ? p.order
          : Number.MAX_SAFE_INTEGER - projects.length + index,
      index,
    }))
    .sort((a, b) => (a.key !== b.key ? a.key - b.key : a.index - b.index))
    .map(({ p }, i) => ({ ...p, order: i }));
}

/**
 * Backfill missing identity fields deterministically: assign a least-used color
 * slot to any record lacking a valid one (in creation order, so the assignment
 * is independent of display order), then normalize display order to a dense
 * range. In-memory only — persisted on the next save.
 */
function backfillProjectIdentity(projects: ProjectRecord[]): ProjectRecord[] {
  let withSlots = projects;
  if (projects.some((p) => !isValidColorSlot(p.colorSlot))) {
    const byCreated = [...projects].sort((a, b) =>
      a.createdAt !== b.createdAt
        ? a.createdAt < b.createdAt
          ? -1
          : 1
        : a.id < b.id
          ? -1
          : 1,
    );
    const assigned = new Map<string, number>();
    const used: { colorSlot?: number }[] = [];
    for (const p of byCreated) {
      if (isValidColorSlot(p.colorSlot)) {
        assigned.set(p.id, p.colorSlot);
        used.push({ colorSlot: p.colorSlot });
      }
    }
    for (const p of byCreated) {
      if (!assigned.has(p.id)) {
        const slot = assignProjectColorSlot(used);
        assigned.set(p.id, slot);
        used.push({ colorSlot: slot });
      }
    }
    withSlots = projects.map((p) => ({ ...p, colorSlot: assigned.get(p.id)! }));
  }
  return normalizeProjectsOrder(withSlots);
}

export async function loadProjects(opts: LoadOptions = {}): Promise<ProjectRecord[]> {
  const path = opts.filePath ?? projectsFilePath(opts.env);
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  let parsed: unknown;
  try {
    parsed = await file.json();
  } catch (e) {
    throw new ProjectRegistryError(
      `failed to parse ${path}: ${(e as Error).message}`,
    );
  }
  if (!parsed || typeof parsed !== "object") return [];
  const root = parsed as Partial<ProjectsFile>;
  if (!Array.isArray(root.projects)) return [];
  const projects: ProjectRecord[] = [];
  for (const raw of root.projects) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Partial<ProjectRecord>;
    if (typeof r.id !== "string" || r.id.length === 0) continue;
    if (typeof r.sourcePath !== "string" || r.sourcePath.length === 0) continue;
    const worktreeDisplayNames = sanitizeWorktreeDisplayNamesMap(
      (r as { worktreeDisplayNames?: unknown }).worktreeDisplayNames,
    );
    const worktreeNotes = sanitizeWorktreeNotesMap(
      (r as { worktreeNotes?: unknown }).worktreeNotes,
    );
    const worktreeComments = sanitizeWorktreeCommentsMap(
      (r as { worktreeComments?: unknown }).worktreeComments,
    );
    projects.push({
      id: r.id,
      sourcePath: normalizeSourcePath(r.sourcePath),
      displayName:
        typeof r.displayName === "string" && r.displayName.length > 0
          ? r.displayName
          : defaultDisplayName(r.sourcePath),
      createdAt: typeof r.createdAt === "string" ? r.createdAt : new Date(0).toISOString(),
      lastSeenAt:
        typeof r.lastSeenAt === "string"
          ? r.lastSeenAt
          : typeof r.createdAt === "string"
            ? r.createdAt
            : new Date(0).toISOString(),
      ...(typeof r.lastError === "string" && r.lastError.length > 0
        ? { lastError: r.lastError }
        : {}),
      ...(isValidColorSlot((r as { colorSlot?: unknown }).colorSlot)
        ? { colorSlot: (r as { colorSlot: number }).colorSlot }
        : {}),
      ...(typeof (r as { order?: unknown }).order === "number" &&
      Number.isFinite((r as { order: number }).order)
        ? { order: (r as { order: number }).order }
        : {}),
      ...(worktreeDisplayNames
        ? { worktreeDisplayNames }
        : {}),
      ...(worktreeNotes ? { worktreeNotes } : {}),
      ...(worktreeComments ? { worktreeComments } : {}),
    });
  }
  return backfillProjectIdentity(projects);
}

function sanitizeWorktreeDisplayNamesMap(
  raw: unknown,
): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k !== "string" || k.length === 0) continue;
    if (typeof v !== "string") continue;
    const trimmed = v.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length > WORKTREE_DISPLAY_NAME_MAX_LENGTH) continue;
    if (/[\x00-\x1f\x7f]/.test(trimmed)) continue;
    out[resolve(k)] = trimmed;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeWorktreeNotesMap(
  raw: unknown,
): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k !== "string" || k.length === 0) continue;
    if (typeof v !== "string") continue;
    const validation = validateWorktreeNote(v);
    if (!validation.ok || validation.value.length === 0) continue;
    out[resolve(k)] = validation.value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeWorktreeCommentsMap(
  raw: unknown,
): Record<string, WorktreeComment[]> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, WorktreeComment[]> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k !== "string" || k.length === 0) continue;
    if (!Array.isArray(v)) continue;
    const list: WorktreeComment[] = [];
    for (const rawEntry of v) {
      if (!rawEntry || typeof rawEntry !== "object") continue;
      const e = rawEntry as Partial<WorktreeComment>;
      if (typeof e.id !== "string" || e.id.length === 0) continue;
      if (typeof e.text !== "string") continue;
      const validation = validateWorktreeComment(e.text);
      if (!validation.ok) continue;
      const createdAt =
        typeof e.createdAt === "string" && e.createdAt.length > 0
          ? e.createdAt
          : new Date(0).toISOString();
      list.push({ id: e.id, text: validation.value, createdAt });
    }
    if (list.length > 0) out[resolve(k)] = list;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface SaveOptions extends LoadOptions {}

export async function saveProjects(
  projects: ProjectRecord[],
  opts: SaveOptions = {},
): Promise<void> {
  const path = opts.filePath ?? projectsFilePath(opts.env);
  await mkdir(dirname(path), { recursive: true });
  const payload: ProjectsFile = { version: 1, projects };
  await Bun.write(path, JSON.stringify(payload, null, 2) + "\n");
}

export interface RegisterProjectOptions extends LoadOptions {
  /** Override clock (tests). */
  now?: () => Date;
  /** Override id generator (tests). */
  newId?: () => string;
  /** Optional display name to use when creating a new record. */
  displayName?: string;
}

export interface RegisterResult {
  project: ProjectRecord;
  created: boolean;
  projects: ProjectRecord[];
}

/**
 * Register a project by source-worktree path. If a project with the same
 * normalized source path already exists, its `lastSeenAt` is bumped and its
 * stable id is preserved. Returns the record and the full updated list.
 */
export async function registerProjectBySourcePath(
  sourcePath: string,
  opts: RegisterProjectOptions = {},
): Promise<RegisterResult> {
  const now = opts.now ?? (() => new Date());
  const newId = opts.newId ?? (() => crypto.randomUUID());
  const normalized = normalizeSourcePath(sourcePath);
  const projects = await loadProjects(opts);
  const idx = projects.findIndex((p) => p.sourcePath === normalized);
  const nowIso = now().toISOString();
  if (idx >= 0) {
    const existing = projects[idx]!;
    const updated: ProjectRecord = {
      ...existing,
      lastSeenAt: nowIso,
    };
    delete updated.lastError;
    projects[idx] = updated;
    await saveProjects(projects, opts);
    return { project: updated, created: false, projects };
  }
  const created: ProjectRecord = {
    id: newId(),
    sourcePath: normalized,
    displayName: opts.displayName ?? defaultDisplayName(normalized),
    createdAt: nowIso,
    lastSeenAt: nowIso,
    colorSlot: assignProjectColorSlot(projects),
    order: projects.length,
  };
  projects.push(created);
  await saveProjects(projects, opts);
  return { project: created, created: true, projects };
}

/** Update a project's lastError field; preserves other fields. */
export async function markProjectError(
  id: string,
  message: string | undefined,
  opts: LoadOptions = {},
): Promise<ProjectRecord | null> {
  const projects = await loadProjects(opts);
  const idx = projects.findIndex((p) => p.id === id);
  if (idx < 0) return null;
  const existing = projects[idx]!;
  const updated: ProjectRecord = { ...existing };
  if (message && message.length > 0) updated.lastError = message;
  else delete updated.lastError;
  projects[idx] = updated;
  await saveProjects(projects, opts);
  return updated;
}

/**
 * Rename a project's display name. Returns the updated record, or `null` when
 * the project is not registered. The value is validated and trimmed; invalid
 * input throws a `ProjectRegistryError`. Preserves id, source path, color slot,
 * order, and worktree metadata.
 */
export async function renameProject(
  id: string,
  displayName: string,
  opts: LoadOptions = {},
): Promise<ProjectRecord | null> {
  const validation = validateProjectDisplayName(displayName);
  if (!validation.ok) throw new ProjectRegistryError(validation.message);
  const projects = await loadProjects(opts);
  const idx = projects.findIndex((p) => p.id === id);
  if (idx < 0) return null;
  const updated: ProjectRecord = {
    ...projects[idx]!,
    displayName: validation.value,
  };
  projects[idx] = updated;
  await saveProjects(projects, opts);
  return updated;
}

/**
 * Set a project's identity color slot. Returns the updated record, or `null`
 * when the project is not registered. An out-of-range or non-integer slot
 * throws a `ProjectRegistryError`. The slot is fixed thereafter and will not be
 * reassigned by later registrations of other projects.
 */
export async function setProjectColorSlot(
  id: string,
  colorSlot: number,
  opts: LoadOptions = {},
): Promise<ProjectRecord | null> {
  if (!isValidColorSlot(colorSlot)) {
    throw new ProjectRegistryError(
      `color slot must be an integer in [0, ${PROJECT_PALETTE_SIZE})`,
    );
  }
  const projects = await loadProjects(opts);
  const idx = projects.findIndex((p) => p.id === id);
  if (idx < 0) return null;
  const updated: ProjectRecord = { ...projects[idx]!, colorSlot };
  projects[idx] = updated;
  await saveProjects(projects, opts);
  return updated;
}

/**
 * Move a project to a target display-order position (0-based). Uses a fractional
 * insert (`target - 0.5`) then renormalizes all orders to a dense 0..n-1 range.
 * Returns the updated record, or `null` when the project is not registered.
 */
export async function reorderProject(
  id: string,
  order: number,
  opts: LoadOptions = {},
): Promise<ProjectRecord | null> {
  if (typeof order !== "number" || !Number.isFinite(order)) {
    throw new ProjectRegistryError("project order must be a finite number");
  }
  const projects = await loadProjects(opts);
  const idx = projects.findIndex((p) => p.id === id);
  if (idx < 0) return null;
  projects[idx] = { ...projects[idx]!, order: order - 0.5 };
  const normalized = normalizeProjectsOrder(projects);
  await saveProjects(normalized, opts);
  return normalized.find((p) => p.id === id)!;
}

/**
 * Remove a project from the registry, renormalizing the remaining projects'
 * display order. Registry-only: it SHALL NOT delete, prune, or modify any Git
 * worktree, branch, checkout, or container on disk. Returns the updated project
 * list, or `null` when no project with the given id exists.
 */
export async function removeProject(
  id: string,
  opts: LoadOptions = {},
): Promise<ProjectRecord[] | null> {
  const projects = await loadProjects(opts);
  if (!projects.some((p) => p.id === id)) return null;
  const next = normalizeProjectsOrder(projects.filter((p) => p.id !== id));
  await saveProjects(next, opts);
  return next;
}

/** Read the persisted note for a worktree path, if any. */
export function getWorktreeNote(
  record: ProjectRecord,
  worktreePath: string,
): string | undefined {
  const map = record.worktreeNotes;
  if (!map) return undefined;
  return map[resolve(worktreePath)];
}

export interface WorktreeNoteUpdateResult {
  /** The project record after the update. */
  project: ProjectRecord;
  /** The persisted note for the worktree path, or undefined when cleared. */
  note: string | undefined;
}

/**
 * Persist a note for a worktree path under the given project. Returns the
 * updated record, or `null` when the project is not registered. The value is
 * validated and trimmed; an empty/whitespace-only note clears the stored note.
 * Invalid input throws a `ProjectRegistryError`.
 */
export async function setWorktreeNote(
  projectId: string,
  worktreePath: string,
  note: string,
  opts: LoadOptions = {},
): Promise<WorktreeNoteUpdateResult | null> {
  const validation = validateWorktreeNote(note);
  if (!validation.ok) {
    throw new ProjectRegistryError(validation.message);
  }
  if (validation.value.length === 0) {
    const project = await removeWorktreeNote(projectId, worktreePath, opts);
    return project ? { project, note: undefined } : null;
  }
  const projects = await loadProjects(opts);
  const idx = projects.findIndex((p) => p.id === projectId);
  if (idx < 0) return null;
  const existing = projects[idx]!;
  const normalized = resolve(worktreePath);
  const nextMap = { ...(existing.worktreeNotes ?? {}) };
  nextMap[normalized] = validation.value;
  const updated: ProjectRecord = {
    ...existing,
    worktreeNotes: nextMap,
  };
  projects[idx] = updated;
  await saveProjects(projects, opts);
  return { project: updated, note: validation.value };
}

/**
 * Remove the persisted note for a worktree path under the given project.
 * Returns the updated record, or `null` when the project is not registered.
 * Quietly succeeds when no note was stored for the path.
 */
export async function removeWorktreeNote(
  projectId: string,
  worktreePath: string,
  opts: LoadOptions = {},
): Promise<ProjectRecord | null> {
  const projects = await loadProjects(opts);
  const idx = projects.findIndex((p) => p.id === projectId);
  if (idx < 0) return null;
  const existing = projects[idx]!;
  const map = existing.worktreeNotes;
  if (!map) return existing;
  const normalized = resolve(worktreePath);
  if (!(normalized in map)) return existing;
  const nextMap: Record<string, string> = { ...map };
  delete nextMap[normalized];
  const updated: ProjectRecord = { ...existing };
  if (Object.keys(nextMap).length > 0) {
    updated.worktreeNotes = nextMap;
  } else {
    delete updated.worktreeNotes;
  }
  projects[idx] = updated;
  await saveProjects(projects, opts);
  return updated;
}

/** Read the persisted comments for a worktree path, in stored order. */
export function getWorktreeComments(
  record: ProjectRecord,
  worktreePath: string,
): WorktreeComment[] {
  const map = record.worktreeComments;
  if (!map) return [];
  return map[resolve(worktreePath)] ?? [];
}

export interface WorktreeCommentAddOptions extends LoadOptions {
  /** Override clock (tests). */
  now?: () => Date;
  /** Override id generator (tests). */
  newId?: () => string;
}

export interface WorktreeCommentAddResult {
  project: ProjectRecord;
  comment: WorktreeComment;
}

/**
 * Append a comment to a worktree under the given project. Returns the updated
 * record and the created comment, or `null` when the project is not
 * registered. The text is validated and trimmed; invalid input throws a
 * `ProjectRegistryError`.
 */
export async function addWorktreeComment(
  projectId: string,
  worktreePath: string,
  text: string,
  opts: WorktreeCommentAddOptions = {},
): Promise<WorktreeCommentAddResult | null> {
  const validation = validateWorktreeComment(text);
  if (!validation.ok) {
    throw new ProjectRegistryError(validation.message);
  }
  const now = opts.now ?? (() => new Date());
  const newId = opts.newId ?? (() => crypto.randomUUID());
  const projects = await loadProjects(opts);
  const idx = projects.findIndex((p) => p.id === projectId);
  if (idx < 0) return null;
  const existing = projects[idx]!;
  const normalized = resolve(worktreePath);
  const comment: WorktreeComment = {
    id: newId(),
    text: validation.value,
    createdAt: now().toISOString(),
  };
  const nextMap: Record<string, WorktreeComment[]> = {
    ...(existing.worktreeComments ?? {}),
  };
  nextMap[normalized] = [...(nextMap[normalized] ?? []), comment];
  const updated: ProjectRecord = { ...existing, worktreeComments: nextMap };
  projects[idx] = updated;
  await saveProjects(projects, opts);
  return { project: updated, comment };
}

/**
 * Remove a comment by id from a worktree under the given project. Returns the
 * updated record, or `null` when the project is not registered. Quietly
 * succeeds when no comment with that id exists for the path.
 */
export async function removeWorktreeComment(
  projectId: string,
  worktreePath: string,
  commentId: string,
  opts: LoadOptions = {},
): Promise<ProjectRecord | null> {
  const projects = await loadProjects(opts);
  const idx = projects.findIndex((p) => p.id === projectId);
  if (idx < 0) return null;
  const existing = projects[idx]!;
  const map = existing.worktreeComments;
  if (!map) return existing;
  const normalized = resolve(worktreePath);
  const list = map[normalized];
  if (!list) return existing;
  const filtered = list.filter((c) => c.id !== commentId);
  if (filtered.length === list.length) return existing;
  const nextMap: Record<string, WorktreeComment[]> = { ...map };
  if (filtered.length > 0) nextMap[normalized] = filtered;
  else delete nextMap[normalized];
  const updated: ProjectRecord = { ...existing };
  if (Object.keys(nextMap).length > 0) updated.worktreeComments = nextMap;
  else delete updated.worktreeComments;
  projects[idx] = updated;
  await saveProjects(projects, opts);
  return updated;
}

/** Read the persisted display name for a worktree path, if any. */
export function getWorktreeDisplayName(
  record: ProjectRecord,
  worktreePath: string,
): string | undefined {
  const map = record.worktreeDisplayNames;
  if (!map) return undefined;
  return map[resolve(worktreePath)];
}

export interface WorktreeDisplayNameUpdateResult {
  /** The project record after the update. */
  project: ProjectRecord;
  /** The persisted display name for the worktree path. */
  displayName: string;
}

/**
 * Persist a display name for a worktree path under the given project. Returns
 * the updated record, or `null` when the project is not registered. The value
 * is validated and trimmed; invalid input throws a `ProjectRegistryError`.
 */
export async function setWorktreeDisplayName(
  projectId: string,
  worktreePath: string,
  displayName: string,
  opts: LoadOptions = {},
): Promise<WorktreeDisplayNameUpdateResult | null> {
  const validation = validateWorktreeDisplayName(displayName);
  if (!validation.ok) {
    throw new ProjectRegistryError(validation.message);
  }
  const projects = await loadProjects(opts);
  const idx = projects.findIndex((p) => p.id === projectId);
  if (idx < 0) return null;
  const existing = projects[idx]!;
  const normalized = resolve(worktreePath);
  const nextMap = { ...(existing.worktreeDisplayNames ?? {}) };
  nextMap[normalized] = validation.value;
  const updated: ProjectRecord = {
    ...existing,
    worktreeDisplayNames: nextMap,
  };
  projects[idx] = updated;
  await saveProjects(projects, opts);
  return { project: updated, displayName: validation.value };
}

/**
 * Remove the persisted display name for a worktree path under the given
 * project. Returns the updated record, or `null` when the project is not
 * registered. Quietly succeeds when no name was stored for the path.
 */
export async function removeWorktreeDisplayName(
  projectId: string,
  worktreePath: string,
  opts: LoadOptions = {},
): Promise<ProjectRecord | null> {
  const projects = await loadProjects(opts);
  const idx = projects.findIndex((p) => p.id === projectId);
  if (idx < 0) return null;
  const existing = projects[idx]!;
  const map = existing.worktreeDisplayNames;
  if (!map) return existing;
  const normalized = resolve(worktreePath);
  if (!(normalized in map)) return existing;
  const nextMap: Record<string, string> = { ...map };
  delete nextMap[normalized];
  const updated: ProjectRecord = { ...existing };
  if (Object.keys(nextMap).length > 0) {
    updated.worktreeDisplayNames = nextMap;
  } else {
    delete updated.worktreeDisplayNames;
  }
  projects[idx] = updated;
  await saveProjects(projects, opts);
  return updated;
}
