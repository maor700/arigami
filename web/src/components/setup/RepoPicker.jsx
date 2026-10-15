// A searchable select over the GitHub repos the connected account can see (GET /__api/onboarding/github/repos).
// Type to filter by owner/name — the host searches server-side, so big orgs stay fast. Shows owner/name, a
// "private" badge and when it was last pushed to. Picking fills the add-repo form; the paste-a-URL box below
// it stays as the fallback, which is why every failure here is a short message and never a dead end.
import { useEffect, useRef, useState, useId } from 'react';
import { api } from '../../lib/api.js';
import { useT } from '../../lib/i18n.js';
import { Icon } from '../../lib/icons.js';
import { agoTime } from '../../lib/time.js';
import { reposPath, mergePage, moveActive } from '../../lib/repo-picker.js';
import { faLock, faCircleNotch, faMagnifyingGlass } from '@fortawesome/free-solid-svg-icons';
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover.jsx';
import { Badge } from '../ui/badge.jsx';
import { INPUT } from './shared.jsx';

const DEBOUNCE_MS = 250;

export default function RepoPicker({ onPick }) {
  const t = useT();
  const id = useId();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState(null); // {code, message}
  const [active, setActive] = useState(-1);
  const [picked, setPicked] = useState(null);
  const seq = useRef(0); // drop answers to a query the user has already typed over

  const load = async (query, pg) => {
    const my = ++seq.current;
    setLoading(true);
    try {
      const r = await api.get(reposPath(query, pg));
      if (my !== seq.current) return;
      if (!r.ok) { setProblem({ code: r.code, message: r.message }); setItems([]); setHasMore(false); }
      else { setProblem(null); setItems((prev) => mergePage(prev, r.items, pg)); setHasMore(!!r.hasMore); setPage(pg); }
    } catch (e) {
      if (my === seq.current) setProblem({ code: 'error', message: e?.message || t('setup.repo.pick.error') });
    }
    if (my === seq.current) setLoading(false);
  };

  // Probe once on mount, so a host without GitHub access hides the picker instead of offering an empty list.
  useEffect(() => { load('', 1); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // Load when opened, then re-query (debounced) as the user types.
  useEffect(() => {
    if (!open) return undefined;
    const h = setTimeout(() => { setActive(-1); load(q, 1); }, q ? DEBOUNCE_MS : 0);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, open]);

  const choose = (r) => { setPicked(r); setQ(''); setOpen(false); onPick?.(r); };
  const onKey = (e) => {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) { e.preventDefault(); setOpen(true); setActive((a) => moveActive(a, e.key, items.length)); }
    else if (e.key === 'Enter' && open && items[active]) { e.preventDefault(); choose(items[active]); }
    else if (e.key === 'Escape') setOpen(false);
  };

  const listId = `${id}-list`;
  // GitHub not connected: say so quietly; the URL / folder fields below still work.
  if (problem?.code === 'no_token' && !open) return null;
  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-fg" htmlFor={`${id}-input`}>{t('setup.repo.pick.label')}</label>
      <Popover open={open}>
      <PopoverAnchor asChild>
      <div className="relative">
        <Icon icon={faMagnifyingGlass} className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-xs text-fgdim" />
        <input
          id={`${id}-input`}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${id}-opt-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          value={q}
          onFocus={() => setOpen(true)}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={onKey}
          placeholder={picked ? picked.fullName : t('setup.repo.pick.placeholder')}
          className={`${INPUT} ps-8`}
        />
        {loading && <Icon icon={faCircleNotch} spin className="absolute end-2.5 top-1/2 -translate-y-1/2 text-xs text-fgdim" />}
      </div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={4}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        className="max-h-[260px] w-(--radix-popper-anchor-width) overflow-y-auto border border-hair p-0 thin-scroll"
      >
        <div>
          {problem ? (
            <div role="alert" dir="auto" className="px-3 py-2.5 text-xs leading-snug text-err">{problem.message}</div>
          ) : (
            <ul id={listId} role="listbox" aria-label={t('setup.repo.pick.label')}>
              {items.map((r, i) => (
                <li
                  key={r.fullName}
                  id={`${id}-opt-${i}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseDown={(e) => { e.preventDefault(); choose(r); }}
                  onMouseEnter={() => setActive(i)}
                  className={`flex cursor-pointer items-center gap-2 border-b border-hair px-3 py-2 last:border-0 coarse:min-h-11 ${i === active ? 'bg-muted' : ''}`}
                >
                  <div className="min-w-0 flex-1">
                    <div dir="ltr" className="truncate text-start font-mono text-xs text-fg"><span className="text-fgdim">{r.owner}/</span><span className="font-medium">{r.name}</span></div>
                    {r.description && <div dir="auto" className="truncate text-xs text-fgdim">{r.description}</div>}
                  </div>
                  {r.private && <Badge status="warn"><Icon icon={faLock} /> {t('setup.repo.pick.private')}</Badge>}
                  {r.updatedAt && <span className="shrink-0 text-xs text-fgdim">{agoTime(r.updatedAt)}</span>}
                </li>
              ))}
              {!loading && items.length === 0 && <li className="px-3 py-2.5 text-xs text-fgdim">{q ? t('setup.repo.pick.noMatch', { q }) : t('setup.repo.pick.empty')}</li>}
              {hasMore && (
                <li>
                  <button type="button" onMouseDown={(e) => { e.preventDefault(); load(q, page + 1); }} className="w-full cursor-pointer px-3 py-2 text-center text-xs font-medium text-fgdim hover:text-fg coarse:min-h-11">{t('setup.repo.pick.more')}</button>
                </li>
              )}
            </ul>
          )}
        </div>
      </PopoverContent>
      </Popover>
    </div>
  );
}
