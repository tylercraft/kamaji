// One site page, one "this site changed": every part of the page loads its own data (the site,
// its backups, its updates), and a save in one part can change what another shows (Configure
// turns whole-site backups on, and the Backups panel should say so at once). Any write calls
// reloadSite(); every resource on the page depends on its version, so each refetches.
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

interface SiteReload {
  /** Bumped by every reloadSite(): a resource that depends on it refetches. */
  version: number;
  reloadSite: () => void;
}

const Context = createContext<SiteReload>({ version: 0, reloadSite: () => {} });

export function SiteReloadProvider({ children }: { children: ReactNode }) {
  const [version, setVersion] = useState(0);
  const reloadSite = useCallback(() => setVersion((v) => v + 1), []);
  const value = useMemo(() => ({ version, reloadSite }), [version, reloadSite]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useSiteReload(): SiteReload {
  return useContext(Context);
}
