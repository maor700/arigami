// OPENUI pilot — the component library an agent may render into the chat via
// `render_ui({ui})` (OpenUI Lang, @openuidev/react-lang). Deliberately small:
// Tailwind + the cockpit's own tokens, plain SVG charts, no @openuidev/react-ui.
// Renderer contract: a component receives `{ props }` (already evaluated), not
// spread props; arguments are POSITIONAL in zod key order, so required keys first.
import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { z } from 'zod';
import { defineComponent, createLibrary, useRenderNode, useTriggerAction, useSetFieldValue, useGetFieldValue, useFormName, FormNameContext } from '@openuidev/react-lang';
import { dirOf } from '../lib/i18n.js';
import { CardFrame, Btn } from './primitives.jsx';

const str = (v) => (v == null ? '' : String(v));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
const list = (v) => (Array.isArray(v) ? v : []);

const Stack = defineComponent({
  name: 'Stack',
  description: 'Vertical (default) or horizontal group of children',
  props: z.object({
    children: z.array(z.any()).describe('child components'),
    direction: z.enum(['column', 'row']).optional().describe('default column'),
  }),
  component: ({ props }) => {
    const rn = useRenderNode();
    const row = props.direction === 'row';
    return <div className={row ? 'flex flex-wrap items-start gap-2' : 'flex flex-col gap-2'}>{rn(list(props.children))}</div>;
  },
});

const Card = defineComponent({
  name: 'Card',
  description: 'Bordered panel with a title',
  props: z.object({ title: z.string().describe('"" for none'), children: z.array(z.any()) }),
  component: ({ props }) => {
    const rn = useRenderNode();
    const title = str(props.title).trim();
    return (
      <CardFrame tone="panel" dense className="my-0">
        {title && <div className="mb-1.5 text-[12.5px] font-bold text-fg" dir={dirOf(title)}>{title}</div>}
        <div className="flex flex-col gap-2">{rn(list(props.children))}</div>
      </CardFrame>
    );
  },
});

const Text = defineComponent({
  name: 'Text',
  description: 'One line or paragraph of plain text',
  props: z.object({ text: z.string(), tone: z.enum(['normal', 'muted', 'strong']).optional() }),
  component: ({ props }) => {
    const text = str(props.text);
    const cls = props.tone === 'muted' ? 'text-fgdim' : props.tone === 'strong' ? 'font-bold text-fg' : 'text-fg';
    return <div className={`text-[12.5px] ${cls}`} dir={dirOf(text)}>{text}</div>;
  },
});

const MarkdownBlock = defineComponent({
  name: 'Markdown',
  description: 'Markdown text (lists, links, code, bold)',
  props: z.object({ text: z.string() }),
  component: ({ props }) => {
    const text = str(props.text);
    return (
      <div className="md text-[12.5px]" dir={dirOf(text)}>
        <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
      </div>
    );
  },
});

const Stat = defineComponent({
  name: 'Stat',
  description: 'A headline number with a label and an optional change',
  props: z.object({ label: z.string(), value: z.string(), delta: z.string().optional().describe('e.g. "+12%"') }),
  component: ({ props }) => {
    const label = str(props.label), value = str(props.value), delta = str(props.delta);
    return (
      <div className="min-w-[96px] rounded-lg border border-hair bg-panel px-3 py-2" dir={dirOf(label)}>
        <div className="text-[11px] text-fgdim">{label}</div>
        <div className="text-[20px] font-bold leading-tight text-fg" dir={dirOf(value)}>{value}</div>
        {delta && <div className="text-[11px] text-[var(--term-accent-fg)]" dir="ltr">{delta}</div>}
      </div>
    );
  },
});

const Table = defineComponent({
  name: 'Table',
  description: 'Rows of cells under column headers',
  props: z.object({
    columns: z.array(z.string()),
    rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))),
  }),
  component: ({ props }) => {
    const cols = list(props.columns).map(str);
    const rows = list(props.rows).map(list).slice(0, 200);
    const dir = dirOf(cols.join(' '));
    return (
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[12px]" dir={dir}>
          <thead>
            <tr>{cols.map((c, i) => <th key={i} className="border-b border-[var(--term-border)] px-2 py-1 text-start font-bold text-fgdim">{c}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-hair last:border-0">
                {cols.map((_, j) => <td key={j} className="px-2 py-1 text-start text-fg" dir={dirOf(str(r[j]))}>{str(r[j])}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  },
});

/* ---------- charts: single series, one hue, plain SVG ---------------------- */
const W = 320, H = 150, PAD = { t: 14, r: 8, b: 26, l: 34 };
const fmt = (n) => (Math.abs(n) >= 1000 ? Math.round(n).toLocaleString() : String(Math.round(n * 100) / 100));

// Shared frame: y grid + axis labels, x category labels. Returns scales.
function useFrame(labels, values) {
  const n = Math.max(labels.length, values.length, 1);
  const max = Math.max(0, ...values), min = Math.min(0, ...values);
  const span = max - min || 1;
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const y = (v) => PAD.t + ih - ((v - min) / span) * ih;
  const x = (i) => PAD.l + (iw / n) * i;
  const ticks = [min, min + span / 2, max];
  return { n, max, min, iw, ih, x, y, ticks, slot: iw / n };
}

function Frame({ labels, f, title, children }) {
  const step = Math.ceil(labels.length / 8); // ≤8 x labels
  return (
    <figure className="m-0">
      {title && <figcaption className="mb-1 text-[11.5px] font-bold text-fg" dir={dirOf(title)}>{title}</figcaption>}
      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full max-w-[420px]" role="img" aria-label={title || labels.join(', ')} style={{ direction: 'ltr' }}>
        {f.ticks.map((t, i) => (
          <g key={i}>
            <line x1={PAD.l} x2={W - PAD.r} y1={f.y(t)} y2={f.y(t)} stroke="var(--term-border)" strokeWidth="1" />
            <text x={PAD.l - 4} y={f.y(t) + 3} textAnchor="end" fontSize="9" fill="var(--term-dim)">{fmt(t)}</text>
          </g>
        ))}
        {labels.map((l, i) => (i % step ? null : (
          <text key={i} x={f.x(i) + f.slot / 2} y={H - PAD.b + 12} textAnchor="middle" fontSize="9" fill="var(--term-dim)">{str(l).slice(0, 10)}</text>
        )))}
        {children}
      </svg>
    </figure>
  );
}

// One schema instance per component: the library keys schemas by identity, so a shared object would collapse two components into one.
const chartProps = () => z.object({
  labels: z.array(z.string()).describe('x categories'),
  values: z.array(z.number()).describe('one value per label'),
  title: z.string().optional(),
});

const BarChart = defineComponent({
  name: 'BarChart',
  description: 'Bar chart, one series',
  props: chartProps(),
  component: ({ props }) => {
    const labels = list(props.labels).map(str), values = list(props.values).map(num);
    const f = useFrame(labels, values);
    const bw = Math.max(2, f.slot * 0.6);
    return (
      <Frame labels={labels} f={f} title={str(props.title)}>
        {values.map((v, i) => {
          const y0 = f.y(0), y1 = f.y(v);
          const top = Math.min(y0, y1), h = Math.max(1, Math.abs(y0 - y1));
          return (
            <g key={i}>
              <rect x={f.x(i) + (f.slot - bw) / 2} y={top} width={bw} height={h} rx="3" fill="var(--color-brand)" opacity="0.85">
                <title>{`${labels[i] ?? i}: ${fmt(v)}`}</title>
              </rect>
            </g>
          );
        })}
      </Frame>
    );
  },
});

const LineChart = defineComponent({
  name: 'LineChart',
  description: 'Line chart over ordered labels, one series',
  props: chartProps(),
  component: ({ props }) => {
    const labels = list(props.labels).map(str), values = list(props.values).map(num);
    const f = useFrame(labels, values);
    const pts = values.map((v, i) => [f.x(i) + f.slot / 2, f.y(v)]);
    const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
    const last = pts.length - 1;
    return (
      <Frame labels={labels} f={f} title={str(props.title)}>
        <path d={d} fill="none" stroke="var(--color-brand)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {pts.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r="4" fill="var(--color-brand)" stroke="var(--term-bg)" strokeWidth="2">
            <title>{`${labels[i] ?? i}: ${fmt(values[i])}`}</title>
          </circle>
        ))}
        {last >= 0 && <text x={pts[last][0]} y={pts[last][1] - 7} textAnchor="middle" fontSize="9" fill="var(--term-fg)">{fmt(values[last])}</text>}
      </Frame>
    );
  },
});

/* ---------- actions & forms ------------------------------------------------ */

const Button = defineComponent({
  name: 'Button',
  description: 'Sends `message` to the agent as the human\'s reply when pressed',
  props: z.object({ label: z.string(), message: z.string().describe('the reply text'), style: z.enum(['default', 'primary']).optional() }),
  component: ({ props }) => {
    const trigger = useTriggerAction();
    const label = str(props.label);
    return (
      <Btn variant={props.style === 'primary' ? 'primary' : 'pill'} dir={dirOf(label)}
        onClick={() => trigger(str(props.message) || label, undefined, { type: 'continue_conversation' })}>
        {label}
      </Btn>
    );
  },
});

const Form = defineComponent({
  name: 'Form',
  description: 'Groups inputs; submit sends `message` plus every field value to the agent',
  props: z.object({
    name: z.string().describe('form id, e.g. "signup"'),
    children: z.array(z.any()).describe('TextInput / Select / Checkbox / Text'),
    submitLabel: z.string().optional().describe('default "Send"'),
    message: z.string().optional().describe('reply text, default "Submitted <name>"'),
  }),
  component: ({ props }) => {
    const rn = useRenderNode();
    const trigger = useTriggerAction();
    const name = str(props.name) || 'form';
    const label = str(props.submitLabel) || 'Send';
    return (
      <FormNameContext.Provider value={name}>
        <form
          className="flex flex-col gap-2"
          data-openui-form={name}
          onSubmit={(e) => { e.preventDefault(); trigger(str(props.message) || `Submitted ${name}`, name, { type: 'continue_conversation' }); }}
        >
          {rn(list(props.children))}
          <div><Btn type="submit" variant="primary" dir={dirOf(label)}>{label}</Btn></div>
        </form>
      </FormNameContext.Provider>
    );
  },
});

const fieldCls = 'w-full rounded-md border border-[var(--term-border)] bg-[var(--term-bg)] px-2 py-1 text-[12.5px] text-fg outline-none focus:border-[var(--term-accent-border)]';

function Field({ label, children }) {
  const l = str(label);
  return (
    <label className="flex flex-col gap-0.5 text-[11px] text-fgdim" dir={dirOf(l)}>
      {l && <span>{l}</span>}
      {children}
    </label>
  );
}

// Field state lives in the Renderer's form store (so submit can read it) and is
// mirrored in local state so the control stays controlled without a re-read.
// The default is written to the store on mount so an untouched field submits too.
function useField(name, type, initial) {
  const form = useFormName();
  const set = useSetFieldValue();
  const get = useGetFieldValue();
  const edited = useRef(false);
  const [v, setV] = useState(() => { const cur = get(form, name); return cur === undefined ? initial : cur; });
  // Mount-time default; never runs over an edit the user already made.
  useEffect(() => { if (!edited.current && get(form, name) === undefined) set(form, type, name, initial, false); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return [v, (next) => { edited.current = true; setV(next); set(form, type, name, next, false); }];
}

const TextInput = defineComponent({
  name: 'TextInput',
  description: 'Single-line text field inside a Form',
  props: z.object({ name: z.string(), label: z.string(), placeholder: z.string().optional(), defaultValue: z.string().optional() }),
  component: ({ props }) => {
    const name = str(props.name) || 'text';
    const [v, set] = useField(name, 'TextInput', str(props.defaultValue));
    return (
      <Field label={props.label}>
        <input className={fieldCls} name={name} value={v} placeholder={str(props.placeholder)} dir={dirOf(v || str(props.placeholder))}
          onChange={(e) => set(e.target.value)} />
      </Field>
    );
  },
});

const Select = defineComponent({
  name: 'Select',
  description: 'Dropdown inside a Form',
  props: z.object({ name: z.string(), label: z.string(), options: z.array(z.string()), defaultValue: z.string().optional() }),
  component: ({ props }) => {
    const name = str(props.name) || 'select';
    const opts = list(props.options).map(str);
    const [v, set] = useField(name, 'Select', str(props.defaultValue) || opts[0] || '');
    return (
      <Field label={props.label}>
        <select className={fieldCls} name={name} value={v} onChange={(e) => set(e.target.value)}>
          {opts.map((o, i) => <option key={i} value={o}>{o}</option>)}
        </select>
      </Field>
    );
  },
});

const Checkbox = defineComponent({
  name: 'Checkbox',
  description: 'Yes/no toggle inside a Form',
  props: z.object({ name: z.string(), label: z.string(), defaultChecked: z.boolean().optional() }),
  component: ({ props }) => {
    const name = str(props.name) || 'check';
    const [v, set] = useField(name, 'Checkbox', props.defaultChecked === true);
    const l = str(props.label);
    return (
      <label className="flex cursor-pointer items-center gap-1.5 text-[12.5px] text-fg" dir={dirOf(l)}>
        <input type="checkbox" name={name} checked={!!v} onChange={(e) => set(e.target.checked)} />
        <span>{l}</span>
      </label>
    );
  },
});

/** The agent-facing set — what render_ui may use. Host cards are NOT here (see define.js / host.jsx). */
export const AGENT_COMPONENTS = [Stack, Card, Text, MarkdownBlock, Stat, Table, BarChart, LineChart, Button, Form, TextInput, Select, Checkbox];
export const library = createLibrary({ components: AGENT_COMPONENTS, root: 'Stack' });

/** Agent-facing syntax help: the library's own signature block wrapped in a short, tool-sized preamble. */
export const OPENUI_RULES = [
  'One statement per line: `name = Component(arg1, arg2, ...)`. `root = Stack([...])` is required and is the entry point.',
  'Arguments are POSITIONAL in the order listed below (no `key: value`); optional ones may be left off the end.',
  'Values: "strings" (double quotes, \\ escapes), numbers, true/false, null, [arrays], and references to other statements.',
  'Every statement except root must be reachable from root (put it in a parent\'s children array) or it is dropped.',
  'Keep a block small — a card, a chart, a short table or one form; it is one message in a chat, not a dashboard.',
  'Hebrew is fine anywhere (every component is RTL-safe). Button and Form submit send text back to you as the human\'s next message; a Form adds a ```json block of its field values.',
];

export const OPENUI_EXAMPLES = [
  'root = Stack([kpis, chart])\nkpis = Stack([s1, s2], "row")\ns1 = Stat("Visitors", "12,480", "+8%")\ns2 = Stat("Sign-ups", "312", "-2%")\nchart = BarChart(["Mon","Tue","Wed","Thu","Fri"], [120, 180, 150, 210, 240], "Sign-ups this week")',
  'root = Stack([card])\ncard = Card("מה להזמין?", [form])\nform = Form("order", [item, qty, rush], "שלח", "Order form submitted")\nitem = Select("item", "פריט", ["חלב", "לחם", "ביצים"])\nqty = TextInput("qty", "כמות", "1")\nrush = Checkbox("rush", "משלוח מהיר")',
];

/** `Comp(arg: type, ...) — description` lines, as library.prompt() prints them. */
export function openuiSignatures() {
  const full = library.prompt();
  const m = full.match(/## Component Signatures\n[\s\S]*?\n\n([\s\S]*?)\n\n## /);
  return (m ? m[1] : full).trim();
}

export function openuiPrompt() {
  return [
    '# OpenUI Lang for render_ui',
    '',
    OPENUI_RULES.map((r) => `- ${r}`).join('\n'),
    '',
    '## Components',
    '',
    openuiSignatures(),
    '',
    '## Examples',
    '',
    OPENUI_EXAMPLES.join('\n\n'),
    '',
  ].join('\n');
}
