// A Linux server's waiting packages, grouped as security / needs care / routine (TY-167); the
// rating in words is on the server's card (UpdatesRating). Kamaji recommends; patching and restarts stay Tyler's.
import type { LinuxHealth, ServerPackage, ServerUpdates } from '@kamaji/shared';
import { Muted, Panel, PanelTitle, Pill, Table, Time } from '../components/ui';
import { Flag } from './MolcajeteFacts';

const LEVEL: Record<ServerUpdates['level'], [string, 'red' | 'amber' | 'green']> = {
  urgent: ['Urgent', 'red'],
  digest: ['For the morning digest', 'amber'],
  ok: ['Nothing pressing', 'green'],
};

/** The rating as a flag and its words, for the server's card. */
export function UpdatesRating({ updates }: { updates: ServerUpdates }) {
  const [label, tone] = LEVEL[updates.level];
  return (
    <>
      <Flag tone={tone}>{label}</Flag>
      {updates.words.map((w) => (
        <Muted key={w}>{w}</Muted>
      ))}
    </>
  );
}

function Packages({ packages, note }: { packages: ServerPackage[]; note: boolean }) {
  return (
    <div css={{ overflowX: 'auto' }}>
      <Table>
        <thead>
          <tr>
            <th scope="col">Package</th>
            <th scope="col">From → to</th>
            <th scope="col">Waiting since</th>
            {note && <th scope="col">Why it matters</th>}
          </tr>
        </thead>
        <tbody>
          {packages.map((p) => (
            <tr key={p.name}>
              <td>
                <code>{p.name}</code>
              </td>
              <td css={{ overflowWrap: 'anywhere' }}>
                {p.from ? (
                  <>
                    {p.from} → {p.to}
                  </>
                ) : (
                  <Muted>Not in this report</Muted>
                )}
              </td>
              <td>
                <Time iso={p.waitingSince} />
              </td>
              {note && (
                <td>
                  {p.internetFacing && <Pill tone="red">Internet-facing: {p.internetFacing}</Pill>}{' '}
                  {p.care && <Muted css={{ display: 'inline' }}>Careful: {p.care}</Muted>}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

export function ServerUpdatesPanel({ name, health }: { name: string; health: LinuxHealth }) {
  const { updates } = health;
  const listed = updates.security.length + updates.care.length + updates.routine.length;
  if (listed === 0 && updates.esm.length === 0) return null;
  const id = `updates-${name}`;
  return (
    <Panel aria-labelledby={id}>
      <PanelTitle id={id}>{name}: waiting updates</PanelTitle>
      {updates.security.length > 0 && (
        <section aria-label="Security updates">
          <h3 css={{ margin: '4px 0', fontSize: 13 }}>Security ({updates.security.length})</h3>
          <Packages packages={updates.security} note />
        </section>
      )}
      {updates.care.length > 0 && (
        <section aria-label="Updates that need care">
          <h3 css={{ margin: '4px 0', fontSize: 13 }}>Needs care ({updates.care.length})</h3>
          <Packages packages={updates.care} note />
        </section>
      )}
      {updates.routine.length > 0 && (
        <details>
          <summary>Routine ({updates.routine.length})</summary>
          <Packages packages={updates.routine} note={false} />
        </details>
      )}
      {updates.truncated && (
        <Muted>
          Showing {listed} of {updates.total}: the report lists security updates first and stops at
          its cap.
        </Muted>
      )}
      {updates.esm.length > 0 && (
        <Muted>Ubuntu Pro (ESM), for information only: {updates.esm.join(', ')}.</Muted>
      )}
    </Panel>
  );
}
