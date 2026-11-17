import type { ComponentType } from 'react';
import { Shell } from './components/Shell';
import { ActivityPage } from './pages/ActivityPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { OverviewPage } from './pages/OverviewPage';
import { PasskeysPage } from './pages/PasskeysPage';
import { AddSitePage } from './pages/AddSitePage';
import { RulesPage } from './pages/RulesPage';
import { SitePage } from './pages/SitePage';
import { ServersPage } from './pages/ServersPage';
import { SettingsPage } from './pages/SettingsPage';
import { SitesPage } from './pages/SitesPage';
import { UpdatesPage } from './pages/UpdatesPage';
import { RouterProvider, useRoute } from './router';
import { GlobalStyles } from './theme';
import { NewsProvider } from './news';

const pages: Record<string, ComponentType> = {
  '/': OverviewPage,
  '/sites': SitesPage,
  '/updates': UpdatesPage,
  '/servers': ServersPage,
  '/activity': ActivityPage,
  '/rules': RulesPage,
  '/passkeys': PasskeysPage,
  '/settings': SettingsPage,
};

function Page() {
  const { path } = useRoute();
  if (path === '/sites/new') return <AddSitePage />;
  const site = /^\/sites\/([a-z0-9.:-]+)$/.exec(path);
  if (site?.[1]) return <SitePage key={site[1]} id={site[1]} />;
  const Current = pages[path] ?? NotFoundPage;
  return <Current />;
}

export function App() {
  return (
    <RouterProvider>
      <GlobalStyles />
      <NewsProvider>
        <Shell>
          <Page />
        </Shell>
      </NewsProvider>
    </RouterProvider>
  );
}
