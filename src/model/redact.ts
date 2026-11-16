/**
 * Keeping personal data out of what the pipeline prints and saves.
 *
 * Diagnostics, `--json` output and the result files end up in CI logs, tickets
 * and chat, and the skill that drives the pipeline names them as the safe
 * things to share. Two sources would break that once customers or orders are in
 * scope:
 *
 * - Node's `JSON.parse` error quotes a piece of the input line in some of its
 *   messages (`Unexpected token '}', ..."m","x":tru}" is not valid JSON`), and a
 *   feed line holds names, emails and addresses.
 * - An API error message can repeat the value it refused. The Import API's
 *   `DuplicateField` error carries the `duplicateValue` and `InvalidField` the
 *   `invalidValue`; the pipeline prints only `code` and `message`, but nothing
 *   promises the message leaves the value out, and a duplicate customer email is
 *   the likeliest case. The record is still named by its key, which is enough to
 *   find it in the feed.
 */

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/** Replaces every email-shaped value with `[email]`. */
export function maskEmails(text: string): string {
  return text.replace(EMAIL, '[email]');
}

/**
 * Where a feed line failed to parse, without the parser's own message: the line
 * is in the diagnostic already, and the column is all a reader needs to open it.
 */
export function describeJsonError(err: unknown): string {
  const message = (err as { message?: unknown } | null)?.message;
  const text = typeof message === 'string' ? message : '';
  const column = /\bcolumn (\d+)\b/.exec(text)?.[1] ?? positionColumn(text);
  return column === undefined ? 'Not valid JSON.' : `Not valid JSON at column ${column}.`;
}

function positionColumn(text: string): string | undefined {
  const position = /\bposition (\d+)\b/.exec(text)?.[1];
  return position === undefined ? undefined : String(Number(position) + 1);
}
