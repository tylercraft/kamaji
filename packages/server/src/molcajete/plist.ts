// Just enough of Apple's XML property list format for `diskutil info -plist`: dict, array,
// string, integer, real, true and false. Anything else (data, date) reads as its text.
export type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };

const TOKEN = /<(\/?)(\w+)(?:\s[^>]*?)?(\/?)>|([^<]+)/g;

const unescape = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

export function parsePlist(xml: string): PlistValue {
  const body = xml.replace(/<\?xml[^>]*\?>/, '').replace(/<!DOCTYPE[^>]*>/, '');
  const tokens: { close: boolean; tag: string; empty: boolean; text?: string }[] = [];
  for (const m of body.matchAll(TOKEN)) {
    if (m[2]) tokens.push({ close: m[1] === '/', tag: m[2], empty: m[3] === '/' });
    else if (m[4] && m[4].trim())
      tokens.push({ close: false, tag: '#text', empty: true, text: m[4] });
  }
  let i = 0;
  const expectClose = (tag: string) => {
    const t = tokens[i++];
    if (!t || !t.close || t.tag !== tag) throw new Error(`plist: expected </${tag}>`);
  };
  const text = (tag: string): string => {
    let out = '';
    if (tokens[i]?.tag === '#text') out = unescape(tokens[i++]?.text ?? '');
    expectClose(tag);
    return out;
  };
  const value = (): PlistValue => {
    const t = tokens[i++];
    if (!t || t.close) throw new Error('plist: unexpected end');
    switch (t.tag) {
      case 'true':
        return true;
      case 'false':
        return false;
      case 'string':
        return t.empty ? '' : text('string');
      case 'integer':
      case 'real':
        return Number(text(t.tag));
      case 'array': {
        const out: PlistValue[] = [];
        if (t.empty) return out;
        while (!(tokens[i]?.close && tokens[i]?.tag === 'array')) out.push(value());
        i++;
        return out;
      }
      case 'dict': {
        const out: { [key: string]: PlistValue } = {};
        if (t.empty) return out;
        while (!(tokens[i]?.close && tokens[i]?.tag === 'dict')) {
          const k = tokens[i++];
          if (k?.tag !== 'key') throw new Error('plist: expected <key>');
          out[text('key')] = value();
        }
        i++;
        return out;
      }
      default:
        return t.empty ? '' : text(t.tag);
    }
  };
  const root = tokens[i++];
  if (root?.tag !== 'plist') throw new Error('plist: no <plist>');
  const result = value();
  expectClose('plist');
  return result;
}
