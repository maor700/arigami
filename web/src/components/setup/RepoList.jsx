// Every REGISTERED repo with its real status — in your workspace / not downloaded / downloading (live) / failed with
// the reason — and a primary Download button for the ones that are not on disk. Polls while a clone runs.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { useT } from '../../lib/i18n.js';
import { serverText } from '../../lib/server-text.js';
import { repoRowModel, anyCloning, newlyCloned } from '../../lib/repo-status.js';
import { BTN2_SM, CARD, Pill, ErrorBox } from './shared.jsx';

export function RepoRow({ repo, onClone, busy }) {
  const t = useT();
  const m = repoRowModel(repo);
  return (
    <div className="border-b border-hair px-3 py-2 last:border-0">
      <div className="flex items-center gap-2.5">
        <Pill status={m.pill} label={t(`setup.repo.state.${m.state}`)} />
        <div className="min-w-0 flex-1">
          <div dir="ltr" className="truncate text-start font-mono text-xs font-medium text-fg">{repo.name}</div>
          <div dir="ltr" className="truncate text-start text-xs text-fgdim">{repo.source}</div>
        </div>
        {m.canClone && (
          <button type="button" disabled={busy} onClick={() => onClone(repo.name)} className={BTN2_SM}>
            {t(m.cloneKey)}
          </button>
        )}
      </div>
      {m.state === 'cloning' && m.progress && <div dir="ltr" className="mt-1 truncate font-mono text-xs text-fgdim">{m.progress}</div>}
      {m.state === 'not_cloned' && <div className="mt-1 text-xs text-fgdim">{t('setup.repo.notDownloadedHint')}</div>}
      {m.state === 'failed' && (
        <div dir="auto" className="mt-1.5 rounded-md border border-err-line bg-err-bg px-3 py-2 text-xs text-err">
          {m.errorKey ? t(m.errorKey) : serverText(m.errorRaw)}
          {m.needsGit && (
            <div className="mt-1.5">
              <a href="#/settings/connections" className={`${BTN2_SM} inline-block no-underline`}>{t('setup.repo.connectGit')}</a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function RepoList({ onChange, refreshKey = 0 }) {
  const t = useT();
  const [repos, setRepos] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const prev = useRef(null);

  const load = useCallback(async () => {
    try {
      const next = await api.get('/onboarding/repos');
      if (newlyCloned(prev.current, next).length) onChange?.();
      prev.current = next;
      setRepos(next);
      setErr(null);
    } catch (e) {
      setErr(e.message);
    }
  }, [onChange]);

  useEffect(() => { load(); }, [load, refreshKey]);
  useEffect(() => {
    if (!anyCloning(repos)) return undefined;
    const id = setInterval(load, 1500);
    return () => clearInterval(id);
  }, [repos, load]);

  const clone = async (name) => {
    setBusy(true);
    setErr(null);
    try {
      await api.post(`/onboarding/repos/${encodeURIComponent(name)}/clone`);
    } catch (e) {
      setErr(e.message);
    }
    await load();
    setBusy(false);
  };

  if (!repos?.length) return <ErrorBox err={err} />;
  return (
    <>
      <div className="mt-3 text-xs font-medium text-fgdim">{t('setup.repo.list.title')}</div>
      <div className={`${CARD} mt-1 overflow-hidden`}>
        {repos.map((r) => <RepoRow key={r.name} repo={r} onClone={clone} busy={busy} />)}
      </div>
      <ErrorBox err={err} />
    </>
  );
}
