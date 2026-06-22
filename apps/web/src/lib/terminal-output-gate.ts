/**
 * Gate for every byte the viewport sends back to the PTY — both user
 * keystrokes and the emulator's own auto-replies (Device Attributes / DSR
 * answers from xterm.js, and our kitty-keyboard protocol replies).
 *
 * The `replaying` guard fixes a reconnect bug: on terminal switch the server
 * replays the byte journal, and any Device Attributes query (`ESC[c`,
 * `ESC[>c`) sitting in that historical scrollback is re-parsed by the fresh
 * xterm.js instance, which dutifully answers it. But the program that asked is
 * long gone, so the reply lands at the idle shell prompt and is echoed as
 * garbage (e.g. `1;2c0;276;0c`). Suppressing all outbound bytes while replay
 * chunks are still being parsed kills those stale replies; the short replay
 * window also makes dropping the rare keystroke typed mid-replay acceptable.
 */
export function canForwardTerminalInput(opts: {
  disposed: boolean;
  replaying: boolean;
  inputEnabled: boolean;
}): boolean {
  return !opts.disposed && !opts.replaying && opts.inputEnabled;
}
