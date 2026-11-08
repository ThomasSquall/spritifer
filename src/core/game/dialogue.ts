/**
 * Dialogues: conversations written as plain text files (dialogues/<file>.dialogue), like a screenplay.
 *
 *   === elder
 *   if !metElder
 *     self: Welcome to Mossbrook, traveler.
 *     self: Will you help us with the slimes?
 *     * I will help!
 *       ~ quest = 1
 *       ~ potions += 1
 *       ! sound powerup
 *       self: Bless you! Take this potion.
 *     * Not my problem.
 *       self: Hmph.
 *     ~ metElder = true
 *   else
 *     self: {count("slime")} slimes still roam the village.
 *
 * One NPC object type can be placed many times: each instance gets its own name, sprite and
 * `dialogue` property, so every villager says something different. See DIALOGUE_REFERENCE.
 */

import { checkExpr, fmt, toNum, truthy } from './expr.js';
import type { Value } from './types.js';

export type Stmt =
  | { k: 'say'; speaker: string | null; text: string; line: number }
  | { k: 'menu'; options: { text: string; cond: string | null; body: Stmt[]; line: number }[]; line: number }
  | { k: 'if'; branches: { cond: string | null; body: Stmt[] }[]; line: number }
  | { k: 'set'; target: string; op: '=' | '+=' | '-='; expr: string; line: number }
  | { k: 'cmd'; name: string; args: string[]; line: number }
  | { k: 'goto'; node: string; line: number };

export interface DialogueNode {
  name: string;
  file: string;
  line: number;
  body: Stmt[];
}

export interface DialogueError {
  file: string;
  line: number;
  message: string;
}

export interface DialogueBook {
  nodes: Map<string, DialogueNode>;
  errors: DialogueError[];
}

export const DIALOGUE_COMMANDS: Record<string, string> = {
  sound: 'sound <name> [volume] — play a sound (coin, jump, hit, hurt, powerup, select, blip...)',
  goto: 'goto <scene> — switch scene (the conversation ends)',
  restart: 'restart — restart the current scene',
  call: 'call <function> [arg expression] — run a script function (self, other, arg)',
  emit: 'emit <message> — send a message to events and scripts',
  wait: 'wait <seconds> — pause the conversation',
  shake: 'shake [intensity] [seconds] — shake the camera',
  anim: 'anim <animation> — play an animation on the speaking instance (self)',
  face: 'face player|left|right|up|down — turn the speaking instance',
  destroy: 'destroy — remove the speaking instance (e.g. a monster that runs away)',
  spawn: 'spawn <object> <x> <y> — create an instance (x/y are expressions, relative to self)',
};

interface RawLine {
  indent: number;
  text: string;
  line: number;
}

const SPEAKER_RE = /^([^:{}"'*~!#=-][^:{}"']{0,39}):\s+(.*)$/;

/** Parses one dialogue file. Node names are shared by all files. */
export function parseDialogues(src: string, file: string): { nodes: DialogueNode[]; errors: DialogueError[] } {
  const errors: DialogueError[] = [];
  const err = (line: number, message: string) => errors.push({ file, line, message });
  const lines: RawLine[] = [];
  src.split(/\r?\n/).forEach((raw, i) => {
    const t = raw.trim();
    if (!t || t.startsWith('#') || t.startsWith('//')) return;
    const ws = /^[ \t]*/.exec(raw)![0];
    lines.push({ indent: ws.replace(/\t/g, '  ').length, text: t, line: i + 1 });
  });

  const nodes: DialogueNode[] = [];
  let p = 0;

  const checkText = (text: string, line: number) => {
    for (const m of text.matchAll(/\{([^}]*)\}/g)) {
      const e = checkExpr(m[1]);
      if (e) err(line, `in {${m[1]}}: ${e}`);
    }
  };
  const checkCond = (expr: string, line: number) => {
    const e = checkExpr(expr);
    if (e) err(line, e);
  };

  /** Parses statements indented at least `min`, all siblings at the indentation of the first one. */
  const block = (min: number): Stmt[] => {
    const out: Stmt[] = [];
    if (p >= lines.length || lines[p].indent < min || lines[p].text.startsWith('===')) return out;
    const indent = lines[p].indent;
    while (p < lines.length && !lines[p].text.startsWith('===')) {
      const L = lines[p];
      if (L.indent < indent) break;
      if (L.indent > indent) {
        err(L.line, 'unexpected indentation');
        p++;
        continue;
      }
      const t = L.text;
      if (t.startsWith('*')) {
        const menu: Extract<Stmt, { k: 'menu' }> = { k: 'menu', options: [], line: L.line };
        while (p < lines.length && lines[p].indent === indent && lines[p].text.startsWith('*')) {
          const O = lines[p];
          let text = O.text.slice(1).trim();
          let cond: string | null = null;
          const m = /\[if\s+(.+)\]\s*$/.exec(text);
          if (m) {
            cond = m[1];
            text = text.slice(0, m.index).trim();
            checkCond(cond, O.line);
          }
          if (!text) err(O.line, 'empty choice');
          checkText(text, O.line);
          p++;
          menu.options.push({ text, cond, body: block(indent + 1), line: O.line });
        }
        out.push(menu);
        continue;
      }
      if (/^if\b/.test(t)) {
        const st: Extract<Stmt, { k: 'if' }> = { k: 'if', branches: [], line: L.line };
        let cond = t.slice(2).trim().replace(/:$/, '');
        if (!cond) err(L.line, 'if needs a condition');
        checkCond(cond, L.line);
        p++;
        st.branches.push({ cond, body: block(indent + 1) });
        while (p < lines.length && lines[p].indent === indent && /^(elif\b|else\b)/.test(lines[p].text)) {
          const B = lines[p];
          p++;
          if (B.text.startsWith('elif')) {
            cond = B.text.slice(4).trim().replace(/:$/, '');
            checkCond(cond, B.line);
            st.branches.push({ cond, body: block(indent + 1) });
          } else {
            st.branches.push({ cond: null, body: block(indent + 1) });
            break;
          }
        }
        out.push(st);
        continue;
      }
      if (/^(elif|else)\b/.test(t)) {
        err(L.line, `${t.split(/\s/)[0]} without an if above it`);
        p++;
        continue;
      }
      p++;
      if (t.startsWith('->')) {
        const node = t.slice(2).trim();
        if (!node) err(L.line, '-> needs a dialogue name (or end)');
        out.push({ k: 'goto', node, line: L.line });
      } else if (t.startsWith('~')) {
        const m = /^~\s*([A-Za-z_][\w.]*)\s*(\+=|-=|=)\s*(.+)$/.exec(t);
        if (!m) err(L.line, 'write variables as: ~ name = expression (or += / -=)');
        else {
          checkCond(m[3], L.line);
          out.push({ k: 'set', target: m[1], op: m[2] as '=' | '+=' | '-=', expr: m[3], line: L.line });
        }
      } else if (t.startsWith('!')) {
        const parts = t.slice(1).trim().split(/\s+/);
        const name = parts.shift() ?? '';
        if (!(name in DIALOGUE_COMMANDS)) err(L.line, `unknown command "${name}". Commands: ${Object.keys(DIALOGUE_COMMANDS).join(', ')}`);
        out.push({ k: 'cmd', name, args: parts, line: L.line });
      } else {
        const m = SPEAKER_RE.exec(t);
        const speaker = m ? m[1].trim() : null;
        const text = m ? m[2] : t;
        checkText(text, L.line);
        out.push({ k: 'say', speaker, text, line: L.line });
      }
    }
    return out;
  };

  while (p < lines.length) {
    const L = lines[p];
    const m = /^===\s*([A-Za-z_][\w-]*)\s*=*$/.exec(L.text);
    if (!m) {
      err(L.line, L.text.startsWith('===') ? 'dialogue names use letters, digits, _ and -' : 'text outside a dialogue: start one with "=== name"');
      p++;
      continue;
    }
    p++;
    const body = block(0);
    if (!body.length) err(L.line, `dialogue "${m[1]}" is empty`);
    nodes.push({ name: m[1], file, line: L.line, body });
  }
  return { nodes, errors };
}

/** Parses every dialogue file and checks jumps between them. */
export function buildDialogueBook(files: Record<string, string>): DialogueBook {
  const nodes = new Map<string, DialogueNode>();
  const errors: DialogueError[] = [];
  for (const file of Object.keys(files).sort()) {
    const r = parseDialogues(files[file], file);
    errors.push(...r.errors);
    for (const n of r.nodes) {
      const dup = nodes.get(n.name);
      if (dup) errors.push({ file, line: n.line, message: `dialogue "${n.name}" already defined in ${dup.file} line ${dup.line}` });
      else nodes.set(n.name, n);
    }
  }
  const walk = (body: Stmt[], node: DialogueNode) => {
    for (const s of body) {
      if (s.k === 'goto' && s.node !== 'end' && !nodes.has(s.node)) errors.push({ file: node.file, line: s.line, message: `-> ${s.node}: no dialogue with that name` });
      if (s.k === 'menu') for (const o of s.options) walk(o.body, node);
      if (s.k === 'if') for (const b of s.branches) walk(b.body, node);
    }
  };
  for (const n of nodes.values()) walk(n.body, n);
  return { nodes, errors };
}

// ---------------------------------------------------------------------------
// Running

/** What the runner needs from the game (implemented by World). */
export interface DialogueHost {
  /** Shows a line (and optional menu); resolves with the chosen index. */
  show(text: string, speaker: string, choices: string[] | null): Promise<number>;
  evaluate(expr: string): Value;
  assign(target: string, value: Value): void;
  read(target: string): Value | undefined;
  command(name: string, args: string[]): Promise<'stop' | void> | 'stop' | void;
  /** Name used for the speaker "self". */
  selfName: string;
  log(message: string): void;
}

const STOP = Symbol('stop');
type Flow = typeof STOP | { goto: string } | undefined;

/** Plays a dialogue node to the end (following -> jumps). */
export async function runDialogue(book: DialogueBook, start: string, host: DialogueHost): Promise<void> {
  let node = book.nodes.get(start);
  if (!node) throw new Error(`no dialogue "${start}"`);
  const interp = (text: string) => text.replace(/\{([^}]*)\}/g, (_, e: string) => fmt(host.evaluate(e)));
  const speakerOf = (s: string | null) => (s === null ? '' : s.toLowerCase() === 'self' ? host.selfName : s);

  const exec = async (body: Stmt[]): Promise<Flow> => {
    for (let i = 0; i < body.length; i++) {
      const s = body[i];
      switch (s.k) {
        case 'say': {
          const next = body[i + 1];
          if (next?.k === 'menu') {
            // A line right before the choices is shown together with them, as the question.
            const flow = await menu(next, interp(s.text), speakerOf(s.speaker));
            i++;
            if (flow) return flow;
          } else await host.show(interp(s.text), speakerOf(s.speaker), null);
          break;
        }
        case 'menu': {
          const flow = await menu(s, '', '');
          if (flow) return flow;
          break;
        }
        case 'if': {
          const b = s.branches.find((br) => br.cond === null || truthy(host.evaluate(br.cond)));
          if (b) {
            const flow = await exec(b.body);
            if (flow) return flow;
          }
          break;
        }
        case 'set': {
          const v = host.evaluate(s.expr);
          if (s.op === '=') host.assign(s.target, v);
          else {
            const cur = host.read(s.target);
            host.assign(s.target, s.op === '+=' ? (typeof cur === 'string' ? cur + fmt(v) : toNum(cur) + toNum(v)) : toNum(cur) - toNum(v));
          }
          break;
        }
        case 'cmd': {
          const r = await host.command(s.name, s.args);
          if (r === 'stop') return STOP;
          break;
        }
        case 'goto':
          return s.node === 'end' ? STOP : { goto: s.node };
      }
    }
    return undefined;
  };

  const menu = async (m: Extract<Stmt, { k: 'menu' }>, question: string, speaker: string): Promise<Flow> => {
    const visible = m.options.filter((o) => o.cond === null || truthy(host.evaluate(o.cond)));
    if (!visible.length) {
      if (question) await host.show(question, speaker, null);
      return undefined;
    }
    const i = await host.show(question, speaker, visible.map((o) => interp(o.text)));
    return exec(visible[Math.max(0, Math.min(visible.length - 1, i))].body);
  };

  for (let jumps = 0; node && jumps < 200; jumps++) {
    const flow = await exec(node.body);
    if (flow && flow !== STOP) {
      const next = book.nodes.get(flow.goto);
      if (!next) throw new Error(`no dialogue "${flow.goto}"`);
      node = next;
      continue;
    }
    break;
  }
}

export const DIALOGUE_REFERENCE = `DIALOGUES — conversations as plain text files (dialogues/<file>.dialogue). A file holds any number of dialogues; names are shared by the whole project.

=== name            starts a dialogue (letters, digits, _ and -)
Speaker: text       a line with a speaker name box
self: text          the speaking instance's name (the placed instance's Name, else its object type)
text                narration (no name box)
{expression}        inserted value: "You have {gold} gold.", "{self.name} waves."
* choice            choices; consecutive * lines form one menu. The line right before them is shown as the question.
* choice [if gold >= 10]   only shown when the condition is true
  indented lines    what happens after that choice (any statements, nested as deep as you like)
if expr / elif expr / else      branches, with indented blocks
~ var = expr        set a variable: globals (gold), self.x (the instance's properties, e.g. self.metHero), scene.x
~ var += expr / ~ var -= expr
! command args      ${Object.values(DIALOGUE_COMMANDS).join('\n                    ')}
-> name             jump to another dialogue; -> end stops
# comment

Expressions are the same as in events: gold >= 10 && !self.angry, count("slime") == 0, random(1, 6),
db("weapons", "bronze", "price") (data tables), fn("canAfford", "bronze") (a func() from a plain script).

USING THEM
- Give an object type the behavior "Talks (dialogue)" (type "dialogue"). Each placed instance can set its own "dialogue" property (and Name, sprite) in the scene inspector,
  so ONE "villager" object type can be every NPC in the game, each with different lines.
- The player talks by pressing action (Space/Z) next to or facing the instance.
- Events: action "Start dialogue" (e.g. WHEN scene starts IF !introDone → Start dialogue intro).
- Scripts: await dialogue('name', self)

EXAMPLE
=== shopkeeper
self: Welcome! Potions are 10 gold.
* Buy a potion [if gold >= 10]
  ~ gold -= 10
  ~ potions += 1
  ! sound coin
  self: Thank you!
  -> shopkeeper
* Just looking.
  self: Come again!`;
