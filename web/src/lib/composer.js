// A4 — composer parsing: slash-commands + @mentions. Pure functions (unit-tested
// in test/agents-a4-web.test.js); the ChatFooter only wires them to the host.
//
//   /plan <text>, /review <text>   → shipped/user skills that declare a `slash:`
//                                     frontmatter field (data-driven, GET /__api/skills)
//   /team                          → host: list the agents + status (TeamPanel)
//   /as <agent> <text>             → host: a one-off session born from the agent
//   /agent new [name]              → host: the create-agent card in this chat
//   @<agent> <text>                → host: delegate (PM → child born from the agent,
//                                     otherwise the agent's home chat)
//   anything else starting with /  → pass-through to the claude CLI (as before)
import { useEffect, useState } from 'react';
import { api } from './api.js';
import { t } from './i18n.js';

// Host commands the composer answers itself (never sent to claude).
export const AGENT_COMMANDS = [
  { name: 'team', descKey: 'dialogs.cmdTeamDesc', host: true, agentCmd: 'team', run: true },
  { name: 'as', descKey: 'dialogs.cmdAsDesc', host: true, agentCmd: 'as', argumentHint: '<agent> <text>' },
  { name: 'agent new', descKey: 'dialogs.cmdAgentNewDesc', host: true, agentCmd: 'agent-new', argumentHint: '[name]' },
];

/** The plugin namespace a skill is invoked under (`/arigami:<name>` / `/arigami-user:<name>`). */
export const skillNamespace = (skill) => (skill?.source === 'user' ? 'arigami-user' : 'arigami');

/** Palette items for the skills that declare `slash:` (shipped + user, user wins by name). */
export function skillSlashItems(skills) {
  const out = [];
  for (const s of skills || []) {
    if (!s?.slash) continue;
    out.push({
      name: s.slash,
      desc: s.description || '',
      argumentHint: s.argumentHint || '',
      host: false,
      skill: s.name,
      command: `${skillNamespace(s)}:${s.name}`,
    });
  }
  return out;
}

/** `/name args…` → {name, args} (name may be "agent new"); null when not a slash line. */
export function parseSlash(text) {
  const m = /^\/([\w:.-]+)(?:[ \t]+([\s\S]*))?$/.exec(String(text || '').trim());
  if (!m) return null;
  let name = m[1];
  let args = (m[2] || '').trim();
  if (name === 'agent' && /^new\b/.test(args)) {
    name = 'agent new';
    args = args.replace(/^new\b\s*/, '').trim();
  }
  return { name, args };
}

/** Lower-cased lookup: slug, name and emoji-less name all resolve an agent. */
export function findAgent(agents, token) {
  const q = String(token || '').trim().toLowerCase().replace(/^@/, '');
  if (!q) return null;
  return (agents || []).find((a) => a.slug.toLowerCase() === q) || (agents || []).find((a) => String(a.name || '').toLowerCase() === q) || null;
}

/**
 * `@<agent>` tokens anywhere in the text (start, after whitespace or punctuation).
 * Only tokens that resolve to a known agent count — an email or "@2pm" is text.
 * Returns {agents:[unique agent], text: the message without the mention tokens}.
 */
export function parseMentions(text, agents) {
  const found = [];
  const seen = new Set();
  const stripped = String(text || '').replace(/(^|[\s(,;:])@([\w-]+)/g, (whole, lead, tok) => {
    const a = findAgent(agents, tok);
    if (!a) return whole;
    if (!seen.has(a.slug)) {
      seen.add(a.slug);
      found.push(a);
    }
    return lead;
  });
  return { agents: found, text: stripped.replace(/[ \t]{2,}/g, ' ').trim() };
}

/** The `@query` token the caret is on (only at the END of the text, like the slash palette) or null. */
export function mentionQuery(text) {
  const m = /(?:^|[\s(,;:])@([\w-]*)$/.exec(String(text || ''));
  return m ? m[1] : null;
}

/** Replace the trailing `@query` with `@<slug> `. */
export function completeMention(text, slug) {
  return String(text || '').replace(/@[\w-]*$/, `@${slug} `);
}

/** Ranked agents for the mention palette. */
export function buildMentionItems(query, agents) {
  const q = String(query || '').toLowerCase();
  const list = (agents || []).filter((a) => !q || a.slug.toLowerCase().includes(q) || String(a.name || '').toLowerCase().includes(q));
  list.sort((a, b) => {
    const ap = a.slug.toLowerCase().startsWith(q) || String(a.name || '').toLowerCase().startsWith(q) ? 0 : 1;
    const bp = b.slug.toLowerCase().startsWith(q) || String(b.name || '').toLowerCase().startsWith(q) ? 0 : 1;
    return ap - bp || a.slug.localeCompare(b.slug);
  });
  return list.slice(0, 12);
}

/**
 * Decide what a composer submission means. Returns one of:
 *   {type:'team'} · {type:'as', agent, text} · {type:'as-usage'} · {type:'unknown-agent', name}
 *   {type:'agent-new', name} · {type:'skill', text: '/arigami:<skill> args'}
 *   {type:'mention', agents, text} · {type:'plain', text}
 */
export function resolveSubmission(text, { skills = [], agents = [] } = {}) {
  const raw = String(text || '').trim();
  const slash = parseSlash(raw);
  if (slash) {
    if (slash.name === 'team') return { type: 'team' };
    if (slash.name === 'agent new') return { type: 'agent-new', name: slash.args };
    if (slash.name === 'as') {
      const m = /^(\S+)\s+([\s\S]+)$/.exec(slash.args);
      if (!m) return { type: 'as-usage' };
      const agent = findAgent(agents, m[1]);
      if (!agent) return { type: 'unknown-agent', name: m[1] };
      return { type: 'as', agent, text: m[2].trim() };
    }
    const item = skillSlashItems(skills).find((s) => s.name === slash.name);
    if (item) return { type: 'skill', text: `/${item.command}${slash.args ? ' ' + slash.args : ''}`, skill: item.skill };
    return { type: 'plain', text: raw };
  }
  const mention = parseMentions(raw, agents);
  if (mention.agents.length && mention.text) return { type: 'mention', agents: mention.agents, text: mention.text };
  return { type: 'plain', text: raw };
}

// ---- skills list (GET /__api/skills), cached per page load ------------------
let skillsCache = null;
let skillsPromise = null;
export function loadSkills() {
  if (skillsCache) return Promise.resolve(skillsCache);
  if (!skillsPromise)
    skillsPromise = api
      .get('/skills')
      .then((r) => (skillsCache = Array.isArray(r?.skills) ? r.skills : []))
      .catch(() => (skillsCache = []));
  return skillsPromise;
}
export function _resetSkillsCache() {
  skillsCache = null;
  skillsPromise = null;
}
export function useSkills() {
  const [skills, setSkills] = useState(skillsCache || []);
  useEffect(() => {
    let alive = true;
    loadSkills().then((s) => alive && setSkills(s));
    return () => {
      alive = false;
    };
  }, []);
  return skills;
}

/** i18n-resolved host agent commands for the palette. */
export const agentCommandItems = () => AGENT_COMMANDS.map((c) => ({ ...c, desc: t(c.descKey) }));
