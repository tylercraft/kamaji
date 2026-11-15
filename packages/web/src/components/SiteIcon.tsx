// A site's favicon beside its name, so sites are quicker to tell apart. Kamaji fetches the icons
// itself (server checks/icons.ts), so the page only ever loads them from Kamaji, and only as an
// <img>: an SVG shown that way can't run script. Until one loads, or when a site has none, it's
// the site name's first letter on a plain tile of the same size, so rows never shift.
import { SiteIconsResponse } from '@kamaji/shared';
import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { getJson } from '../api';

// Which sites have an icon, by the hash of its bytes, and every site's name: one request for the
// whole page, shared by every SiteIcon, and asked again every 15 minutes. A site without an icon
// gets its name's letter, with no request that would only 404.
let list: SiteIconsResponse = { icons: {}, names: {} };
const listeners = new Set<() => void>();
let timer: number | undefined;

/** Asks for the list again now: after Refetch icon, so a new icon shows at once. */
export async function load() {
  try {
    list = await getJson('/api/site-icons', SiteIconsResponse);
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

/** The letter on the tile: the name's first letter or digit, or none before the names load. */
export const iconLetter = (name: string | undefined) =>
  (name?.match(/[\p{L}\p{N}]/u)?.[0] ?? '').toUpperCase();

/** A site's icon, `size` pixels square: 16 in lists, 24 on the site's own page, 48 in Sites. */
export function SiteIcon({ id, size = 16 }: { id: string; size?: 16 | 24 | 48 }) {
  const { icons, names } = useSyncExternalStore(
    subscribe,
    () => list,
    () => list,
  );
  const version = icons[id];
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
        borderRadius: size === 48 ? 6 : 3,
        overflow: 'hidden',
        verticalAlign: 'middle',
        background: loaded ? 'transparent' : 'var(--soft)',
        color: 'var(--muted)',
        font: `600 ${Math.round(size * 0.62)}px/1 var(--sans)`,
      }}
    >
      {!loaded && iconLetter(names[id])}
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
