import { useEffect, useRef, useState } from 'react';

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
// `truncate` utility and an overflow-aware title.
export function Truncate({ text, as: Tag = 'span', className = '', children, ...rest }) {
  const content = children ?? text;
  const { ref, title } = useOverflowTitle(typeof content === 'string' ? content : text);
  return (
    <Tag ref={ref} title={title} className={`truncate ${className}`} {...rest}>
      {content}
    </Tag>
  );
}
