/** Saved playtests: a run of the game with fixed input and what must be true at the end. */

import { type PlaytestInput, type PlaytestResult, runPlaytest } from './engine.js';
import type { EngineOptions } from './engine.js';
import { checkExpr } from './expr.js';
import type { GameBundle, Value } from './types.js';

export interface GameTest {
  format: 'spritifer-test';
  name: string;
  description?: string;
  /** Start here instead of the start scene. */
  scene?: string;
  seed: number;
  seconds: number;
  vars?: Record<string, Value>;
  playerAt?: [number, number];
  inputs: PlaytestInput[];
  /** Answers for dialog menus; only used with autoDialog. */
  choices?: number[];
  /** false: dialogs are driven by the recorded keys. Recordings always use false. */
  autoDialog?: boolean;
  expect: {
    /** The scene the game must end in. */
    scene?: string;
    /** Expressions that must all be true at the end. */
    exprs?: string[];
    /** Text that must appear in the log. */
    logs?: string[];
    /** Fail on any runtime or script error (default true). */
    noErrors?: boolean;
  };
  updatedBy?: string;
}

export interface TestOutcome {
  name: string;
  passed: boolean;
  failures: string[];
  seconds: number;
  finalScene: string;
  logs: string[];
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

export function assertTestName(name: string): void {
  if (!NAME_RE.test(name)) throw new Error(`Invalid test name "${name}". Use letters, digits, "_" and "-".`);
}

const isValue = (v: unknown): v is Value => typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean';

export function normalizeTest(v: unknown, name: string): GameTest {
  assertTestName(name);
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const e = (o.expect && typeof o.expect === 'object' ? o.expect : {}) as Record<string, unknown>;
  const strings = (x: unknown) => (Array.isArray(x) ? x.map(String).map((s) => s.trim()).filter(Boolean) : undefined);
  const inputs: PlaytestInput[] = (Array.isArray(o.inputs) ? o.inputs : []).flatMap((x: unknown): PlaytestInput[] => {
    const i = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    if (typeof i.at !== 'number' || i.at < 0) return [];
    if (typeof i.key === 'string' && i.key) return [{ at: i.at, key: i.key, ...(typeof i.duration === 'number' ? { duration: i.duration } : {}) }];
    if (Array.isArray(i.click) && i.click.length === 2) return [{ at: i.at, click: [Number(i.click[0]), Number(i.click[1])] as [number, number] }];
    return [];
  });
  const vars = o.vars && typeof o.vars === 'object' ? Object.fromEntries(Object.entries(o.vars).filter(([, x]) => isValue(x))) as Record<string, Value> : undefined;
  const exprs = strings(e.exprs);
  for (const src of exprs ?? []) {
    const err = checkExpr(src);
    if (err) throw new Error(`expect "${src}": ${err}`);
  }
  const logs = strings(e.logs);
  const test: GameTest = {
    format: 'spritifer-test',
    name,
    seed: typeof o.seed === 'number' ? Math.floor(o.seed) : 1,
    seconds: Math.max(0.1, Math.min(600, typeof o.seconds === 'number' ? o.seconds : 1)),
    inputs,
    expect: {
      ...(typeof e.scene === 'string' && e.scene ? { scene: e.scene } : {}),
      ...(exprs?.length ? { exprs } : {}),
      ...(logs?.length ? { logs } : {}),
      noErrors: e.noErrors !== false,
    },
  };
  if (typeof o.description === 'string' && o.description) test.description = o.description;
  if (typeof o.scene === 'string' && o.scene) test.scene = o.scene;
  if (vars && Object.keys(vars).length) test.vars = vars;
  if (Array.isArray(o.playerAt) && o.playerAt.length === 2) test.playerAt = [Number(o.playerAt[0]), Number(o.playerAt[1])];
  if (Array.isArray(o.choices)) test.choices = o.choices.map(Number).filter(Number.isInteger);
  if (typeof o.autoDialog === 'boolean') test.autoDialog = o.autoDialog;
  if (typeof o.updatedBy === 'string') test.updatedBy = o.updatedBy;
  return test;
}

export function judgeTest(test: GameTest, r: PlaytestResult): TestOutcome {
  const failures: string[] = [];
  const e = test.expect;
  const finalScene = r.final.scene;
  if (e.noErrors !== false) for (const l of r.logs.filter((x) => x.startsWith('ERROR')).slice(0, 5)) failures.push(l);
  if (e.scene && finalScene !== e.scene) failures.push(`ended in scene "${finalScene}", expected "${e.scene}"`);
  for (const src of e.exprs ?? []) {
    try {
      if (!r.world.test(src)) failures.push(`not true at the end: ${src}`);
    } catch (err) {
      failures.push(`${src}: ${(err as Error).message}`);
    }
  }
  for (const text of e.logs ?? []) if (!r.logs.some((l) => l.includes(text))) failures.push(`not in the log: ${text}`);
  return { name: test.name, passed: !failures.length, failures, seconds: r.seconds, finalScene, logs: r.logs.slice(-40) };
}

export async function runGameTest(bundle: GameBundle, test: GameTest, evaluator?: EngineOptions['evaluator']): Promise<TestOutcome & { result: PlaytestResult }> {
  const result = await runPlaytest(bundle, {
    seconds: test.seconds,
    scene: test.scene,
    seed: test.seed,
    vars: test.vars,
    playerAt: test.playerAt,
    inputs: test.inputs,
    choices: test.choices,
    autoDialog: test.autoDialog,
    evaluator,
  });
  return { ...judgeTest(test, result), result };
}
