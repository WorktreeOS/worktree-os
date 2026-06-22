/**
 * Terminal session title normalization and validation.
 *
 * The title appears in compact rail rows, modal sheets, and terminal headers,
 * so the daemon trims input, treats `null` / empty-after-trim as a clear-title
 * request, rejects control characters, and enforces a bounded length. Keeping
 * this in the daemon (rather than the UI) means every API client — including
 * non-browser clients — stays consistent.
 */

/** Maximum number of visible characters allowed in a terminal session title. */
export const MAX_TERMINAL_TITLE_LENGTH = 80;

/** Raised when a submitted terminal title fails validation. */
export class TerminalTitleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalTitleValidationError";
  }
}

/**
 * True when the string contains an ASCII C0 control character, DEL, or a C1
 * control character. Checked by code point so no control byte is embedded in
 * this source file.
 */
function hasControlCharacter(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * Normalize a submitted terminal title.
 *
 * - `null` / `undefined` / empty-after-trim → `undefined` (clear the title).
 * - Trims surrounding whitespace.
 * - Rejects ASCII C0 control characters, DEL, and the C1 control range.
 * - Rejects titles longer than {@link MAX_TERMINAL_TITLE_LENGTH} after trim.
 *
 * @throws TerminalTitleValidationError when the title is invalid.
 */
export function normalizeTerminalTitle(
  input: string | null | undefined,
): string | undefined {
  if (input === null || input === undefined) return undefined;
  if (typeof input !== "string") {
    throw new TerminalTitleValidationError("title must be a string or null");
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) return undefined;
  // A control character could inject escape sequences or break single-line
  // row layouts, so reject it outright rather than stripping it.
  if (hasControlCharacter(trimmed)) {
    throw new TerminalTitleValidationError(
      "title must not contain control characters",
    );
  }
  if (trimmed.length > MAX_TERMINAL_TITLE_LENGTH) {
    throw new TerminalTitleValidationError(
      `title must be at most ${MAX_TERMINAL_TITLE_LENGTH} characters`,
    );
  }
  return trimmed;
}
