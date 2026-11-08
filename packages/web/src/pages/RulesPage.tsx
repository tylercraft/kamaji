import { Empty, PageHeading, Panel } from '../components/ui';

export function RulesPage() {
  return (
    <>
      <PageHeading
        title="Rules"
        purpose="Set the boundaries for automatic updates. Review these when your needs change."
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
