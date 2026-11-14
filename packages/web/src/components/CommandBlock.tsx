// A shell command to run, with a Copy button beside it. Every command Kamaji shows goes through
// CommandBlock, so each one can be copied whole instead of picked out by hand on a phone.
import styled from '@emotion/styled';
import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from './ui';

interface CopyEnv {
  clipboard?: { writeText: (text: string) => Promise<void> } | undefined;
  document?: Pick<Document, 'createElement' | 'body' | 'execCommand'> | undefined;
}

/**
 * Copies `text` exactly. The Clipboard API first; where it's missing or refuses (older iOS Safari,
 * a page that isn't on HTTPS), a hidden textarea and execCommand('copy'), which still works there.
 */
export async function copyText(
  text: string,
  env: CopyEnv = {
    clipboard: typeof navigator === 'undefined' ? undefined : navigator.clipboard,
    document: typeof document === 'undefined' ? undefined : document,
  },
): Promise<boolean> {
  if (env.clipboard?.writeText) {
    try {
      await env.clipboard.writeText(text);
      return true;
    } catch {
      // Falls through to the textarea.
    }
  }
  const doc = env.document;
  if (!doc) return false;
  const area = doc.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  // 16px so iOS doesn't zoom in; fixed and transparent so nothing moves or shows.
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px;pointer-events:none';
  doc.body.appendChild(area);
  try {
    area.select();
    area.setSelectionRange(0, text.length);
    return doc.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

const CopyBox = styled(Button)`
  flex: none;
  justify-content: center;
  min-width: 82px;
  @media (max-width: 640px) {
    min-height: 44px;
  }
`;

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [said, setSaid] = useState<'copied' | 'failed' | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  async function copy() {
    const ok = await copyText(text);
    setSaid(ok ? 'copied' : 'failed');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setSaid(null), 2000);
  }
  return (
    <CopyBox type="button" onClick={copy} aria-label={said ? undefined : `${label} command`}>
      {said === 'copied' ? (
        <Check size={14} aria-hidden="true" />
      ) : (
        <Copy size={14} aria-hidden="true" />
      )}
      <span aria-live="polite">
        {said === 'copied' ? 'Copied' : said === 'failed' ? 'Select it to copy' : label}
      </span>
    </CopyBox>
  );
}

const Block = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: flex-start;
  min-width: 0;
  pre {
    /* The button drops below the command where there's no room beside it. */
    flex: 1 1 220px;
    min-width: 0;
    margin: 0;
    padding: 8px 10px;
    background: var(--sunken, var(--panel));
    border: 1px solid var(--line);
    border-radius: var(--radius);
    font-size: 12px;
    /* Wrapped rather than scrolled, so the whole command shows, in a table cell too. */
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
`;

/** One command, shown as it will be run, and the button that copies exactly that. */
export function CommandBlock({ command }: { command: string }) {
  return (
    <Block>
      <pre>
        <code>{command}</code>
      </pre>
      <CopyButton text={command} />
    </Block>
  );
}
