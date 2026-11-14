import { describe, expect, it, vi } from 'vitest';
import { copyText } from './components/CommandBlock';

const COMMAND = '/usr/bin/sudo /usr/bin/sed -i \'\' \'/"id":"abc"/d\' /etc/kamaji/passkeys';

/** Just enough of a document for the textarea fallback, recording what it was asked to copy. */
function fakeDocument(copies = true) {
  const copied: string[] = [];
  let attached: { value: string; removed: boolean } | null = null;
  const doc = {
    body: {
      appendChild: (el: { value: string; removed: boolean }) => void (attached = el),
    },
    createElement: () => {
      const el = {
        value: '',
        removed: false,
        style: { cssText: '' },
        setAttribute: () => {},
        select: () => {},
        setSelectionRange: () => {},
        remove: () => void (el.removed = true),
      };
      return el;
    },
    execCommand: () => {
      if (attached) copied.push(attached.value);
      return copies;
    },
  };
  return { doc: doc as never, copied, attached: () => attached };
}

describe('copyText', () => {
  it('copies the exact command with the Clipboard API, with no newline added', async () => {
    const writeText = vi.fn(async () => {});
    const { doc, copied } = fakeDocument();
    expect(await copyText(COMMAND, { clipboard: { writeText }, document: doc })).toBe(true);
    expect(writeText).toHaveBeenCalledWith(COMMAND);
    expect(copied).toEqual([]);
  });

  it('falls back to a textarea and execCommand when the Clipboard API is missing', async () => {
    const { doc, copied, attached } = fakeDocument();
    expect(await copyText(COMMAND, { document: doc })).toBe(true);
    expect(copied).toEqual([COMMAND]);
    expect(attached()?.removed).toBe(true);
  });

  it('falls back when the Clipboard API refuses', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('NotAllowedError');
    });
    const { doc, copied } = fakeDocument();
    expect(await copyText(COMMAND, { clipboard: { writeText }, document: doc })).toBe(true);
    expect(copied).toEqual([COMMAND]);
  });

  it('says so when neither works', async () => {
    const { doc, attached } = fakeDocument(false);
    expect(await copyText(COMMAND, { document: doc })).toBe(false);
    expect(attached()?.removed).toBe(true);
    expect(await copyText(COMMAND, {})).toBe(false);
  });
});
