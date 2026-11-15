// The end of what a failed command said, kept with a failed restore check so "database.sql didn't
// import" comes with the reason. Scrubbed before it's stored: anything that looks like a password
// or a long token is replaced, and MariaDB's "near '…'" quote of the dump (which can hold a
// client's data) is cut short. Each line is capped, so one huge line can't fill the row.

export const TAIL_LINES = 20;
const LINE_CAP = 300;
const NEAR_CAP = 40;
const HIDDEN = '[hidden]';

const SECRET_PATTERNS: [RegExp, string][] = [
  // key=value and key: value, for anything named like a secret.
  [
    /\b([\w.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|auth)[\w.-]*)(\s*[=:]\s*)((?:Bearer|Basic)\s+\S+|"[^"]*"|'[^']*'|\S+)/gi,
    `$1$2${HIDDEN}`,
  ],
  // mysql -pSECRET and --password SECRET.
  [/(\s-p)(?!\s)\S+/g, `$1${HIDDEN}`],
  [/(--password\s+)\S+/gi, `$1${HIDDEN}`],
  // Bearer and Basic credentials, and user:password@ in a URL.
  [/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, `$1 ${HIDDEN}`],
  [/(\/\/[^\s/:@]+:)[^\s/@]+@/g, `$1${HIDDEN}@`],
  // Long runs that look like keys or tokens: 32 or more letters, digits and token punctuation.
  // Not slashes, so a path still reads.
  [/[A-Za-z0-9+_=-]{32,}/g, HIDDEN],
];

/** One line, scrubbed and capped. */
export function scrubLine(line: string): string {
  // Colour codes and carriage-return redraws aren't words.
  let out = line
    .replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g'), '')
    .replace(/^.*\r(?!$)/, '');
  out = out.replace(
    /(near\s+')([^']*)('?)/gi,
    (_m, start: string, quoted: string, end: string) =>
      `${start}${quoted.length > NEAR_CAP ? `${quoted.slice(0, NEAR_CAP)}…` : quoted}${end}`,
  );
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out.length > LINE_CAP ? `${out.slice(0, LINE_CAP)}…` : out;
}

/** The last 20 non-blank lines of `text`, scrubbed; null when there's nothing. */
export function stderrTail(text: string | undefined): string | null {
  const lines = (text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '');
  if (lines.length === 0) return null;
  return lines.slice(-TAIL_LINES).map(scrubLine).join('\n');
}
