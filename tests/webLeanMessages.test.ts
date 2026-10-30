import { describe, expect, it } from 'vitest';
import { leanMarks, leanMessages, sameLeanFile } from '../apps/web/client/leanMessages';

const rfl = 'Submission.lean:4:44: error: The rfl tactic failed. Possible reasons:\n- The goal is not a reflexive relation.\nn : Nat\n⊢ 0 + n = n';

describe('Lean messages in a check\'s output', () => {
  it('reads each message with its location, its later lines and where the location stands in the output', () => {
    const output = `${rfl}\nSubmission.lean:9:2: error(lean.unknownIdentifier): Unknown identifier \`foo\`\n`
      + 'Submission.lean:12:31: warning: Variable name `h` is not explicitly referenced.\n\nHint: The binding can be removed.\n\n';
    const messages = leanMessages(output);
    expect(messages.map(({ file, line, column, severity }) => [file, line, column, severity])).toEqual([
      ['Submission.lean', 4, 44, 'error'], ['Submission.lean', 9, 2, 'error'], ['Submission.lean', 12, 31, 'warning']]);
    expect(messages[0]!.text).toBe('The rfl tactic failed. Possible reasons:\n- The goal is not a reflexive relation.\nn : Nat\n⊢ 0 + n = n');
    expect(messages[1]!.text).toBe('Unknown identifier `foo`');
    expect(messages[2]!.text).toBe('Variable name `h` is not explicitly referenced.\n\nHint: The binding can be removed.');
    expect(messages.map(message => output.slice(message.start, message.end))).toEqual(['Submission.lean:4:44', 'Submission.lean:9:2', 'Submission.lean:12:31']);
  });

  it('reads Lake\'s form, ends a message at Lake\'s own closing line and leaves other lines alone', () => {
    const output = '✖ [3/4] Building Submission\ntrace: .> LEAN_PATH=…\nerror: ./././Submission.lean:3:2: unknown identifier \'x\'\nerror: Lean exited with code 1\n'
      + 'see Submission.lean:7:1 for the definition';
    const messages = leanMessages(output);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ file: './././Submission.lean', line: 3, column: 2, severity: 'error', text: 'unknown identifier \'x\'' });
    expect(output.slice(messages[0]!.start, messages[0]!.end)).toBe('./././Submission.lean:3:2');
    expect(leanMessages('no messages here\nSubmission.lean:1:0 without a severity')).toEqual([]);
  });

  it('names a file the way Lean may, relative to the project or not, and no other file', () => {
    expect(sameLeanFile('./Submission.lean', 'Submission.lean')).toBe(true);
    expect(sameLeanFile('/work/project/Submission/Helpers.lean', 'Submission/Helpers.lean')).toBe(true);
    expect(sameLeanFile('Submission/.deepscientist-declarations-c74f.lean', 'Submission/Helpers.lean')).toBe(false);
    expect(sameLeanFile('OtherSubmission.lean', 'Submission.lean')).toBe(false);
  });
});

describe('Lean messages on a file\'s lines', () => {
  it('puts each error under its line once, in line order, and counts the errors on lines the file does not have', () => {
    const output = 'Submission.lean:8:4: error: second\nSubmission.lean:4:44: error: first\nSubmission.lean:4:2: error: earlier on the line\n'
      + 'Submission.lean:6:0: warning: declaration uses \'sorry\'\nSubmission.lean:2:0: info: 2\n'
      + 'Submission/.deepscientist-declarations-c74f.lean:3:0: error: probe\nSubmission.lean:40:0: error: past the end';
    const marks = leanMarks([output, output.split('\n').slice(0, 2).join('\n')], 'Submission.lean', 10);
    expect([...marks.lines].map(([line, items]) => [line, items.map(item => item.lines[0])])).toEqual([
      [4, ['earlier on the line', 'first']], [8, ['second']]]);
    expect(marks.elsewhere).toBe(2);
  });

  it('shows the warnings when no output has an error, and shows the first lines of a long message', () => {
    const warnings = leanMarks(['Submission.lean:6:8: warning: declaration uses \'sorry\'\nOther.lean:1:0: warning: elsewhere'], 'Submission.lean', 10);
    expect([...warnings.lines]).toEqual([[6, [{ severity: 'warning', column: 8, lines: ['declaration uses \'sorry\''], more: 0 }]]]);
    expect(warnings.elsewhere).toBe(0);
    expect(leanMarks(['Other.lean:1:0: error: there', 'Submission.lean:6:8: warning: here'], 'Submission.lean', 10).lines.size).toBe(0);
    const long = leanMarks([rfl], 'Submission.lean', 10, 2).lines.get(4)!;
    expect(long).toEqual([{ severity: 'error', column: 44, lines: ['The rfl tactic failed. Possible reasons:', '- The goal is not a reflexive relation.'], more: 2 }]);
    expect(leanMarks([], 'Submission.lean', 10)).toEqual({ lines: new Map(), elsewhere: 0 });
  });
});
