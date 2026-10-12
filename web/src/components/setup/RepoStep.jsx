// S2 — manual.kind 'repo': every registered repo with its real status + Download, and the add form (clone / copy a
// repository the host owns). Adding a name that is already registered is not an error: it downloads it if it is not
// on disk yet, or says it is already in the workspace.
import { useState } from 'react';
import { useT } from '../../lib/i18n.js';
import * as setupApi from '../../lib/setup-api.js';
import { addOutcome } from '../../lib/repo-status.js';
import { AddRepo } from '../Setup.jsx';
import RepoList from './RepoList.jsx';
import { CARD, ErrorBox, OkLine, useAction } from './shared.jsx';

export default function RepoStep({ capability = 'repo', onDone }) {
  const t = useT();
  const { busy, err, run } = useAction();
  const [note, setNote] = useState(null);
  const [tick, setTick] = useState(0);
  const add = (entry) =>
    run(async () => {
      const r = await setupApi.connect(capability, { entry });
      setNote({ key: addOutcome(r), name: r?.name || entry.name });
      setTick((n) => n + 1);
      onDone?.(r);
    });
  const key = { already: 'setup.repo.already', 'cloning-existing': 'setup.repo.alreadyCloning', added: 'setup.repo.added' };
  return (
    <>
      <RepoList onChange={onDone} refreshKey={tick} />
      {note && <OkLine>{t(key[note.key], { name: note.name })}</OkLine>}
      <div className={`${CARD} mt-2 overflow-hidden`}>
        <AddRepo onAdd={add} busy={busy} defaultOpen />
      </div>
      <ErrorBox err={err} />
    </>
  );
}
