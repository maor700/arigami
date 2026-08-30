// S2 — manual.kind 'repo': add (clone / copy) a repository the host owns.
// Wraps Setup.jsx's AddRepo form; for `repo:<name>` capabilities the name is
// prefilled by the card's title, the form itself is unchanged.
import { useT } from '../../lib/i18n.js';
import * as setupApi from '../../lib/setup-api.js';
import { AddRepo } from '../Setup.jsx';
import { CARD, ErrorBox, OkLine, useAction } from './shared.jsx';

export default function RepoStep({ capability = 'repo', have = [], onDone }) {
  const t = useT();
  const { busy, err, run } = useAction();
  const add = (entry) =>
    run(async () => {
      const r = await setupApi.connect(capability, { entry });
      onDone?.(r);
    });
  return (
    <>
      {have.length > 0 && <OkLine>{t('setup.repo.have', { names: have.join(', ') })}</OkLine>}
      <div className={`${CARD} mt-2 overflow-hidden`}>
        <AddRepo onAdd={add} busy={busy} />
      </div>
      <ErrorBox err={err} />
    </>
  );
}
