// Settings › Customization — how the agents behave (PROMPT1). For now the instruction blocks only; phase 2 adds what
// an agent or a session inherits. The editor itself stays collapsed until opened (Instructions.jsx): the page should
// not invite casual edits, the defaults are meant to just work.
import { useT } from '../../lib/i18n.js';
import Instructions from './Instructions.jsx';

export default function Customization() {
  const t = useT();
  return (
    <>
      <p className="mb-4 text-sm text-fgdim">{t('customization.intro')}</p>
      <Instructions />
    </>
  );
}
