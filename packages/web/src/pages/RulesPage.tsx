import { Empty, PageHeading, Panel } from '../components/ui';

export function RulesPage() {
  return (
    <>
      <PageHeading
        title="Rules"
        purpose="Not in this version: every update is approved by you under Updates."
      />
      <Panel>
        <Empty title="No rules: every update is approved by you">
          Rules aren’t in this version. They start as a view over WordPress’s own per-plugin
          auto-updates, verified like any other update, once the approved-update loop has earned
          trust.
        </Empty>
      </Panel>
    </>
  );
}
