import { describe, expect, it } from 'vitest';
import { scrubLine, stderrTail } from './stderrTail.js';

describe('a failed command’s tail', () => {
  it('keeps the last 20 lines that say something', () => {
    const text = Array.from({ length: 25 }, (_, i) => `line ${i}`).join('\n\n');
    expect(stderrTail(text)?.split('\n')).toEqual(
      Array.from({ length: 20 }, (_, i) => `line ${i + 5}`),
    );
    expect(stderrTail('')).toBeNull();
    expect(stderrTail(undefined)).toBeNull();
    expect(stderrTail('\n  \n')).toBeNull();
  });

  it('hides anything like a password or a token', () => {
    expect(scrubLine('MYSQL_PASSWORD=s3cret!')).toBe('MYSQL_PASSWORD=[hidden]');
    expect(scrubLine('db_password: "two words"')).toBe('db_password: [hidden]');
    expect(scrubLine('mariadb -uroot -ps3cret wordpress')).toBe(
      'mariadb -uroot -p[hidden] wordpress',
    );
    expect(scrubLine('Authorization: Bearer abc.def.ghi')).toBe('Authorization: [hidden]');
    expect(scrubLine('curl https://kamaji:hunter2@example.test/')).toBe(
      'curl https://kamaji:[hidden]@example.test/',
    );
    expect(scrubLine(`key ${'f'.repeat(40)}`)).toBe('key [hidden]');
  });

  it('leaves ordinary words, paths and codes as they are', () => {
    const plain =
      'ERROR 2002 (HY000): Can’t connect to server on /Users/tylercraft/kamaji-restore/site (111)';
    expect(scrubLine(plain)).toBe(plain);
  });

  it('cuts a long line, and colour codes', () => {
    expect(scrubLine('x'.repeat(10) + ' ' + 'y '.repeat(400))).toHaveLength(301);
    expect(scrubLine(`${String.fromCharCode(27)}[31mred${String.fromCharCode(27)}[0m`)).toBe('red');
  });
});
