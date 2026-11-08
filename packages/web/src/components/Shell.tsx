import styled from '@emotion/styled';
import { StatusResponse } from '@kamaji/shared';
import {
  Glasses,
  Globe,
  History,
  LayoutDashboard,
  PackageCheck,
  Server,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { cycleHealth, heartbeatHealth } from '../kamajiHealth';
import { useLink, useRoute } from '../router';
import { useResource } from '../useResource';
import { ThemeToggle } from './ThemeToggle';
import { Dot, Pill } from './ui';

export const tabs: { path: string; label: string; icon: LucideIcon }[] = [
  { path: '/', label: 'Overview', icon: LayoutDashboard },
  { path: '/sites', label: 'Sites', icon: Globe },
  { path: '/updates', label: 'Updates', icon: PackageCheck },
  { path: '/servers', label: 'Servers', icon: Server },
  { path: '/activity', label: 'Activity', icon: History },
  { path: '/rules', label: 'Rules', icon: ShieldCheck },
];

const Top = styled.header`
  min-height: 54px;
  padding: 11px 20px;
  display: flex;
  gap: 16px;
  align-items: center;
  flex-wrap: wrap;
  background: var(--panel);
`;

const Brand = styled.span`
  font: 600 22px/1 var(--serif);
  letter-spacing: -0.6px;
  display: flex;
  align-items: center;
  gap: 9px;
`;

const Mark = styled.span`
  width: 30px;
  height: 28px;
  background: var(--metal);
  color: var(--metal-ink);
  border-radius: 5px;
  display: grid;
  place-items: center;
`;

const Workspace = styled.span`
  padding-left: 16px;
  border-left: 1px solid var(--line);
  color: var(--muted);
  font-size: 12px;
`;

const Nav = styled.nav`
  display: flex;
  gap: 5px;
  padding: 0 20px;
  background: var(--panel);
  border-bottom: 1px solid var(--line);
  flex-wrap: wrap;
  a {
    display: flex;
    align-items: center;
    gap: 7px;
    border-bottom: 2px solid transparent;
    padding: 12px 13px;
    color: var(--muted);
    font-size: 12px;
    text-decoration: none;
  }
  a:hover {
    color: var(--ink);
  }
  a[aria-current='page'] {
    color: var(--copper);
    border-bottom-color: var(--copper);
    font-weight: 650;
  }
`;

const Main = styled.main`
  padding: 20px;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--gap);
  max-width: 1600px;
  @media (max-width: 600px) {
    padding: 16px;
  }
`;

const SkipLink = styled.a`
  position: absolute;
  left: 8px;
  top: -40px;
  padding: 6px 10px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  z-index: 1;
  &:focus {
    top: 8px;
  }
`;

function Tab({ path, label, icon: Icon }: (typeof tabs)[number]) {
  const { path: current } = useRoute();
  const link = useLink(path);
  return (
    <a {...link} aria-current={current === path ? 'page' : undefined}>
      <Icon size={15} aria-hidden="true" />
      {label}
    </a>
  );
}

/** Kamaji's own health in a word or two; the detail is on Overview. */
function StatusSummary() {
  const status = useResource('/api/status', StatusResponse, { pollMs: 30_000 });
  if (status.state === 'loading') return <Pill>Checking Kamaji…</Pill>;
  if (status.state === 'error')
    return (
      <Pill tone="red" role="status">
        <Dot /> {status.message}
      </Pill>
    );
  if (status.refreshError)
    return (
      <Pill tone="red" role="status">
        <Dot /> Lost contact with Kamaji
      </Pill>
    );
  const lines = [cycleHealth(status.data), heartbeatHealth(status.data)];
  return (
    <span css={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} role="status">
      {lines.map((line) => (
        <Pill key={line.label} tone={line.tone} title={line.detail}>
          <Dot /> {line.label}
        </Pill>
      ))}
    </span>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  return (
    <>
      <SkipLink href="#main">Skip to content</SkipLink>
      <Top>
        <Brand>
          <Mark aria-hidden="true">
            <Glasses size={16} />
          </Mark>
          Kamaji
        </Brand>
        <Workspace>The boiler room</Workspace>
        <span
          css={{
            marginLeft: 'auto',
            display: 'flex',
            gap: 10,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <StatusSummary />
          <ThemeToggle />
        </span>
      </Top>
      <Nav aria-label="Main">
        {tabs.map((tab) => (
          <Tab key={tab.path} {...tab} />
        ))}
      </Nav>
      <Main id="main">{children}</Main>
    </>
  );
}
