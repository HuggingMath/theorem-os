/**
 * Lean's own messages in a check's output, so the trajectory can put each one under the line of code it is about.
 * Lean writes `File.lean:12:4: error: …` (Lake: `error: ./File.lean:12:4: …`), lines from 1 and columns from 0,
 * and the lines after a header belong to its message until the next header or a line of Lake's own.
 */
export type LeanSeverity = 'error' | 'warning' | 'info';
export type LeanMessage = {
  file: string; line: number; column: number; severity: LeanSeverity; text: string;
  /** Where `File.lean:12:4` stands in the output, for a link to the line. */ start: number; end: number;
};
/** A message under its line: its first lines, and how many more the full output has. */
export type LeanMark = { severity: LeanSeverity; column: number; lines: string[]; more: number };
/** The messages about one file, keyed by line, and how many errors name a line this file does not have. */
export type LeanMarks = { lines: Map<number, LeanMark[]>; elsewhere: number };

const header = /^(?:(error|warning|info)(?:\([^)\n]*\))?: )?((?:\.\/)*[^\s:]+\.lean):(\d+):(\d+):(?: (error|warning|info)(?:\([^)\n]*\))?:)?/u;
// Lake's closing lines, such as `error: Lean exited with code 1`, end the message before them.
const trailer = /^(?:error|warning|info): /u;

export function leanMessages(output: string): LeanMessage[] {
  const messages: LeanMessage[] = [];
  let open: { message: LeanMessage; lines: string[] } | undefined, offset = 0;
  const close = () => {
    if (!open) return;
    while (open.lines.length > 1 && !open.lines.at(-1)!.trim()) open.lines.pop();
    open.message.text = open.lines.join('\n').trim();
    messages.push(open.message);
    open = undefined;
  };
  for (const line of output.split('\n')) {
    const found = header.exec(line), severity = found?.[1] ?? found?.[5];
    if (found && severity) {
      close();
      const prefix = found[1] ? line.indexOf(found[2]!) : 0, start = offset + prefix;
      const location = `${found[2]}:${found[3]}:${found[4]}`;
      open = { message: { file: found[2]!, line: Number(found[3]), column: Number(found[4]), severity: severity as LeanSeverity, text: '',
        start, end: start + location.length }, lines: [line.slice(found[0].length).trimStart()] };
    } else if (open && trailer.test(line)) close();
    else open?.lines.push(line);
    offset += line.length + 1;
  }
  close();
  return messages;
}

const plain = (file: string) => file.replace(/\\/gu, '/').replace(/^(?:\.\/)+/u, '');
/** Whether Lean's name for a file is `file`, a path inside the project; Lean may name it relative to the project or not. */
export function sameLeanFile(named: string, file: string) {
  const a = plain(named), b = plain(file);
  return a === b || a.endsWith(`/${b}`);
}

/**
 * The messages to show on `file`'s lines: its errors, or, when no output has an error, its warnings (a `sorry` can be
 * why a check failed). Information messages are left to the full output. A message on a line past the end of the
 * file, or about another file, such as one the checker wrote, is counted as elsewhere if it is an error.
 */
export function leanMarks(outputs: readonly string[], file: string, lineCount: number, maximumLines = 8): LeanMarks {
  const seen = new Set<string>(), messages: LeanMessage[] = [];
  for (const output of outputs) for (const message of leanMessages(output)) {
    const key = `${plain(message.file)}\u0000${message.line}\u0000${message.column}\u0000${message.severity}\u0000${message.text}`;
    if (message.severity === 'info' || seen.has(key)) continue;
    seen.add(key); messages.push(message);
  }
  const severity: LeanSeverity = messages.some(message => message.severity === 'error') ? 'error' : 'warning';
  const lines = new Map<number, LeanMark[]>();
  let elsewhere = 0;
  for (const message of messages.filter(item => item.severity === severity).sort((a, b) => a.line - b.line || a.column - b.column)) {
    if (!sameLeanFile(message.file, file) || message.line < 1 || message.line > lineCount) {
      if (severity === 'error') elsewhere++;
      continue;
    }
    const text = message.text ? message.text.split('\n') : [], marks = lines.get(message.line) ?? [];
    marks.push({ severity, column: message.column, lines: text.slice(0, maximumLines), more: Math.max(0, text.length - maximumLines) });
    lines.set(message.line, marks);
  }
  return { lines, elsewhere };
}
