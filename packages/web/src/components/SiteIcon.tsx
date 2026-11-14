// A site's favicon beside its name, so sites are quicker to tell apart. Kamaji fetches the icons
// itself (server checks/icons.ts), so the page only ever loads them from Kamaji, and only as an
// <img>: an SVG shown that way can't run script. Until one loads, or when a site has none, it's
// the domain's first letter on a plain tile of the same size, so rows never shift.
import { SiteIconsResponse } from '@kamaji/shared';
import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { getJson } from '../api';

// Which sites have an icon, by the hash of its bytes: one request for the whole page, shared by
// every SiteIcon, and asked again every 15 minutes. A site not listed gets the letter, with no
// request that would only 404.
let versions: Record<string, string> = {};
const listeners = new Set<() => void>();
let timer: number | undefined;

async function load() {
  try {
    versions = (await getJson('/api/site-icons', SiteIconsResponse)).icons;
    listeners.forEach((l) => l());
  } catch {
    // Letters until the next try.
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (timer === undefined) {
    void load();
    timer = window.setInterval(() => void load(), 15 * 60_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
}

/** The letter on the tile: the domain's first, without www. */
export const iconLetter = (id: string) => (id.replace(/^www\./i, '')[0] ?? '?').toUpperCase();

/** A site's icon, `size` pixels square: 16 in lists, 24 on the site's own page. */
export function SiteIcon({ id, size = 16 }: { id: string; size?: 16 | 24 }) {
  const version = useSyncExternalStore(
    subscribe,
    () => versions[id],
    () => undefined,
  );
  // The version that has loaded: a new version shows the letter again until it has.
  const [shown, setShown] = useState<string | null>(null);
  const loaded = version !== undefined && shown === version;
  return (
    <span
      aria-hidden="true"
      css={{
        position: 'relative',
        display: 'inline-grid',
        placeItems: 'center',
        flex: 'none',
        width: size,
        height: size,
        borderRadius: 3,
        overflow: 'hidden',
        verticalAlign: 'middle',
        background: loaded ? 'transparent' : 'var(--soft)',
        color: 'var(--muted)',
        font: `600 ${Math.round(size * 0.62)}px/1 var(--sans)`,
      }}
    >
      {!loaded && iconLetter(id)}
      {version !== undefined && (
        <img
          src={`/api/sites/${encodeURIComponent(id)}/icon?v=${version}`}
          alt=""
          width={size}
          height={size}
          decoding="async"
          onLoad={() => setShown(version)}
          css={{
            position: 'absolute',
            inset: 0,
            width: size,
            height: size,
            objectFit: 'contain',
            opacity: loaded ? 1 : 0,
          }}
        />
      )}
    </span>
  );
}

/** A site's name with its icon in front: what lists and headings show. */
export function WithIcon({
  id,
  size = 16,
  children,
}: {
  id: string;
  size?: 16 | 24;
  children: ReactNode;
}) {
  return (
    <span
      css={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: size === 24 ? 10 : 7,
        minWidth: 0,
      }}
    >
      <SiteIcon id={id} size={size} />
      <span css={{ minWidth: 0 }}>{children}</span>
    </span>
  );
}
