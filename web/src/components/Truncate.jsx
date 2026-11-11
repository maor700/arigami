import { useEffect, useRef, useState } from 'react';
import { strongDirOf } from '../lib/i18n.js';

// Sets a native `title` equal to the full text only when the element is
// actually overflowing (scrollWidth > clientWidth). Watches size via
// ResizeObserver so it stays correct as the rail/tabs resize.
export function useOverflowTitle(text) {
  const ref = useRef(null);
  const [overflow, setOverflow] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const check = () => setOverflow(el.scrollWidth > el.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);

  const str = text == null ? '' : String(text);
  return { ref, title: overflow ? str : undefined };
}

// Drop-in truncating element. Renders a <span> (override via `as`) with the
// `truncate` utility and an overflow-aware title. A Truncate that carries its
// own `dir` (a title whose language differs from the UI) still aligns to the UI's
// start edge (`ui-start`), so a row's title, chips and indicator share one edge.
export function Truncate({ text, as: Tag = 'span', className = '', children, ...rest }) {
  const content = children ?? text;
  const { ref, title } = useOverflowTitle(typeof content === 'string' ? content : text);
  // Ellipsis and clipping happen at the END of the element's own direction, so
  // user text must be laid out in ITS direction (an English title in a Hebrew UI
  // keeps its start and loses its tail, not the other way round).
  const dir = rest.dir ?? (typeof content === 'string' ? strongDirOf(content) : undefined);
  return (
    <Tag ref={ref} title={title} className={`truncate ${dir ? 'ui-start ' : ''}${className}`} {...rest} dir={dir}>
      {content}
    </Tag>
  );
}
