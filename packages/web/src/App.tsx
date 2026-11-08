import type { ComponentType } from 'react';
import { Shell } from './components/Shell';
import { ActivityPage } from './pages/ActivityPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { OverviewPage } from './pages/OverviewPage';
import { RulesPage } from './pages/RulesPage';
import { ServersPage } from './pages/ServersPage';
import { SitesPage } from './pages/SitesPage';
import { UpdatesPage } from './pages/UpdatesPage';
import { RouterProvider, useRoute } from './router';
import { GlobalStyles } from './theme';

const pages: Record<string, ComponentType> = {
  '/': OverviewPage,
  '/sites': SitesPage,
  '/updates': UpdatesPage,
  '/servers': ServersPage,
  '/activity': ActivityPage,
  '/rules': RulesPage,
};

function Page() {
  const { path } = useRoute();
  const Current = pages[path] ?? NotFoundPage;
  return <Current />;
}

export function App() {
  return (
    <RouterProvider>
      <GlobalStyles />
      <Shell>
        <Page />
      </Shell>
    </RouterProvider>
  );
}
