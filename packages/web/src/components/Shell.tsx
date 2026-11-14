import styled from '@emotion/styled';
import { StatusResponse } from '@kamaji/shared';
import {
  Globe,
  History,
  KeyRound,
  LayoutDashboard,
  Menu as MenuIcon,
  PackageCheck,
  Server,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { alertsHealth, cycleHealth, heartbeatHealth } from '../kamajiHealth';
import { useLink, useRoute } from '../router';
import { useResource } from '../useResource';
import { ThemeToggle } from './ThemeToggle';
import { Toasts } from './toast';
import { Dot, Pill } from './ui';

export const tabs: { path: string; label: string; icon: LucideIcon }[] = [
  { path: '/', label: 'Overview', icon: LayoutDashboard },
  { path: '/sites', label: 'Sites', icon: Globe },
  { path: '/updates', label: 'Updates', icon: PackageCheck },
  { path: '/servers', label: 'Servers', icon: Server },
  { path: '/activity', label: 'Activity', icon: History },
  // Rules (/rules) is left out until there are rules to set: every update is approved by hand.
];

// One iron header at laptop widths: the brand, the five tabs, then Kamaji's own health. Under
// 980px the tabs wrap onto their own row below the brand. On a phone (640px and under) it's the
// brand and a menu button, as on the Calcifer dashboard: a checkbox holds the menu open, with no
// script, and the menu covers the page with the tabs, Passkeys, Kamaji's health and Appearance.
const PHONE = '@media (max-width: 640px)';

const Top = styled.header`
  display: flex;
  align-items: stretch;
  gap: 0 20px;
  min-height: 56px;
  padding: 0 18px;
  background: var(--chrome);
  color: var(--chrome-ink);
  box-shadow: inset 0 1px var(--seam);
  border-bottom: 1px solid var(--seam);
  @media (max-width: 980px) {
    flex-wrap: wrap;
    gap: 0 8px;
    padding: 0 14px;
  }
  .menu-toggle,
  .menu-button {
    display: none;
  }
  .menu {
    display: contents;
  }
  .menu-only {
    display: none;
  }
  ${PHONE} {
    position: sticky;
    top: 0;
    z-index: 10;
    flex-wrap: nowrap;
    align-items: center;
    .menu-toggle {
      display: block;
      position: absolute;
      opacity: 0;
      width: 1px;
      height: 1px;
      pointer-events: none;
    }
    .menu-button {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-left: auto;
      margin-right: -8px;
      width: 44px;
      height: 44px;
      border-radius: 3px;
      color: var(--chrome-ink);
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;
    }
    .menu-button .menu-close {
      display: none;
    }
    .menu-toggle:checked ~ .menu-button .menu-open {
      display: none;
    }
    .menu-toggle:checked ~ .menu-button .menu-close {
      display: block;
    }
    .menu-toggle:focus-visible ~ .menu-button {
      outline: 2px solid var(--chrome-ink);
      outline-offset: 2px;
    }
    .menu-flag {
      position: absolute;
      top: 8px;
      right: 6px;
      width: 9px;
      height: 9px;
      border-radius: 50%;
      border: 1.5px solid var(--chrome);
    }
    .menu-toggle:checked ~ .menu-button .menu-flag {
      display: none;
    }
    .menu {
      display: none;
      position: fixed;
      inset: 57px 0 0;
      z-index: 9;
      overflow-y: auto;
      flex-direction: column;
      gap: 18px;
      padding: 12px 16px calc(24px + env(safe-area-inset-bottom));
      background: var(--chrome);
    }
    .menu-toggle:checked ~ .menu {
      display: flex;
    }
    .menu-only {
      display: contents;
    }
  }
`;

const Brand = styled.a`
  flex: none;
  align-self: center;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 50px;
  font: 500 20px/1 var(--mono);
  letter-spacing: -0.65px;
  white-space: nowrap;
  color: inherit;
  text-decoration: none;
`;

/** Round black lenses, a narrow bridge and a broad, jagged moustache (the prototype's mark). */
const Mark = styled.span`
  position: relative;
  display: block;
  width: 49px;
  height: 43px;
  flex: 0 0 49px;
  span {
    position: absolute;
  }
  .lens {
    top: 4px;
    width: 19px;
    height: 19px;
    border: 1.6px solid var(--rim);
    border-radius: 50%;
    background: var(--lens);
    z-index: 2;
  }
  .lens::after {
    content: '';
    position: absolute;
    right: 3px;
    top: 2px;
    width: 4px;
    height: 8px;
    border-radius: 50%;
    background: var(--glint);
    transform: rotate(-35deg);
    opacity: 0.7;
  }
  .left {
    left: 3px;
    transform: rotate(-13deg);
  }
  .right {
    right: 3px;
    transform: rotate(13deg);
  }
  .bridge {
    left: 21px;
    top: 11px;
    width: 7px;
    height: 4px;
    border-top: 1.6px solid var(--rim);
    border-radius: 50%;
    z-index: 1;
  }
  .moustache {
    left: 0;
    bottom: 2px;
    width: 49px;
    height: 20px;
    background: var(--hair);
    clip-path: polygon(
      50% 11%,
      60% 0,
      76% 13%,
      100% 37%,
      87% 41%,
      97% 58%,
      81% 57%,
      89% 77%,
      69% 67%,
      61% 95%,
      51% 76%,
      42% 100%,
      35% 74%,
      13% 82%,
      22% 63%,
      0 61%,
      13% 45%,
      1% 34%,
      28% 10%,
      40% 0
    );
  }
`;

const Nav = styled.nav`
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: stretch;
  gap: 2px;
  a {
    display: flex;
    align-items: center;
    gap: 7px;
    min-height: 56px;
    padding: 0 11px;
    border-bottom: 2px solid transparent;
    color: var(--chrome-muted);
    font: 11px/1.2 var(--mono);
    letter-spacing: 0.1px;
    white-space: nowrap;
    text-decoration: none;
  }
  a:hover {
    color: var(--chrome-ink);
  }
  a[aria-current='page'] {
    background: var(--panel);
    color: var(--ink);
    border-bottom-color: var(--seam-copper);
    font-weight: 500;
  }
  @media (max-width: 980px) {
    order: 3;
    flex: 1 0 100%;
    flex-wrap: wrap;
    a {
      min-height: 44px;
      padding: 0 12px;
    }
  }
  ${PHONE} {
    order: 0;
    flex: none;
    flex-direction: column;
    flex-wrap: nowrap;
    gap: 2px;
    a {
      min-height: 52px;
      padding: 0 12px;
      gap: 12px;
      font-size: 16px;
      border-bottom: 0;
      border-left: 2px solid transparent;
      border-radius: 3px;
    }
    a[aria-current='page'] {
      border-left-color: var(--seam-copper);
    }
    a svg {
      width: 20px;
      height: 20px;
    }
  }
`;

const Health = styled.div`
  margin-left: auto;
  align-self: center;
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
  padding: 8px 0;
  ${PHONE} {
    margin-left: 0;
    align-self: stretch;
    flex-direction: column;
    align-items: flex-start;
    justify-content: flex-start;
    gap: 14px;
    padding: 14px 12px 0;
    border-top: 1px solid var(--seam);
    .passkeys-link {
      display: none;
    }
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
    <a
      {...link}
      aria-current={
        current === path || (path !== '/' && current.startsWith(`${path}/`)) ? 'page' : undefined
      }
    >
      <Icon size={15} aria-hidden="true" />
      {label}
    </a>
  );
}

type Status = ReturnType<typeof useStatus>;
const useStatus = () => useResource('/api/status', StatusResponse, { pollMs: 30_000 });

/** On the phone's menu button: a dot when Kamaji's own health needs a look. */
function MenuFlag({ status }: { status: Status }) {
  let tone: string | null = null;
  if (status.state === 'error' || (status.state === 'ready' && status.refreshError)) tone = 'red';
  else if (status.state === 'ready') {
    const lines = [
      cycleHealth(status.data),
      heartbeatHealth(status.data),
      alertsHealth(status.data),
    ];
    tone = lines.some((l) => l.tone === 'red')
      ? 'red'
      : lines.some((l) => l.tone === 'amber')
        ? 'amber'
        : null;
  }
  return tone ? (
    <span className="menu-flag" css={{ background: `var(--${tone})` }} aria-hidden="true" />
  ) : null;
}

/** Kamaji's own health in a word or two; the detail is on Overview. */
function StatusSummary({ status }: { status: Status }) {
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
  const lines = [cycleHealth(status.data), heartbeatHealth(status.data), alertsHealth(status.data)];
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

function PasskeysLink() {
  const link = useLink('/passkeys');
  return (
    <a {...link} className="passkeys-link" css={{ fontSize: 12, color: 'var(--muted)' }}>
      Passkeys
    </a>
  );
}

function Home() {
  const link = useLink('/');
  return (
    <Brand {...link} aria-label="Kamaji overview">
      <Mark aria-hidden="true">
        <span className="lens left" />
        <span className="lens right" />
        <span className="bridge" />
        <span className="moustache" />
      </Mark>
      Kamaji
    </Brand>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const status = useStatus();
  const { path } = useRoute();
  return (
    <>
      <SkipLink href="#main">Skip to content</SkipLink>
      <Top>
        <Home />
        {/* Keyed on the page, so moving to another page closes the menu. */}
        <input key={path} type="checkbox" id="menu" className="menu-toggle" aria-label="Menu" />
        <label htmlFor="menu" className="menu-button" title="Menu">
          <MenuIcon className="menu-open" size={26} aria-hidden="true" />
          <X className="menu-close" size={26} aria-hidden="true" />
          <MenuFlag status={status} />
        </label>
        <div className="menu">
          <Nav aria-label="Main">
            {tabs.map((tab) => (
              <Tab key={tab.path} {...tab} />
            ))}
            <span className="menu-only">
              <Tab path="/passkeys" label="Passkeys" icon={KeyRound} />
            </span>
          </Nav>
          <Health>
            <StatusSummary status={status} />
            <PasskeysLink />
            <ThemeToggle />
          </Health>
        </div>
      </Top>
      <Main id="main">{children}</Main>
      <Toasts />
    </>
  );
}
