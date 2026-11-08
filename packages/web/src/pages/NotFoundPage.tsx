import { Empty, PageHeading, Panel } from '../components/ui';
import { useLink } from '../router';

export function NotFoundPage() {
  const home = useLink('/');
  return (
    <>
      <PageHeading title="Not found" purpose="There’s no page at this address." />
      <Panel>
        <Empty title="Nothing here">
          <a {...home}>Back to Overview</a>
        </Empty>
      </Panel>
    </>
  );
}
