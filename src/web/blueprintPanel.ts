/** The blueprint of a scene in the editor: its text, its plan, what is wrong with it, and compiling it into the map. */

import { h, modal, toast } from './dom.js';
import { type BlueprintAnswer, gameApi } from './gameApi.js';

export async function openBlueprint(scene: string): Promise<void> {
  const first = await gameApi.blueprint(scene);
  await modal(`Blueprint: ${scene}`, (close) => {
    const text = h('textarea', { spellcheck: false, style: 'width:100%;height:60vh;font:12px monospace;white-space:pre' }) as HTMLTextAreaElement;
    const plan = h('img', { alt: 'Plan of the map', style: 'max-width:100%;image-rendering:pixelated' }) as HTMLImageElement;
    const list = h('div', { style: 'max-height:24vh;overflow:auto;font-size:12px;margin-top:8px' });
    const show = (a: BlueprintAnswer) => {
      if (a.blueprint) text.value = JSON.stringify(a.blueprint, null, 1);
      if (a.plan) plan.src = `data:image/png;base64,${a.plan}`;
      const problems = a.problems ?? [];
      list.replaceChildren(...(problems.length ? problems.map((p) => h('div', { style: `color:${p.level === 'error' ? '#ff6b60' : '#ffd166'}` }, `${p.cell ? `(${p.cell.join(', ')}) ` : ''}${p.message}`)) : [h('div', {}, a.blueprint ? 'No problems.' : 'This scene has no blueprint yet.')]));
    };
    show(first);
    const parsed = () => {
      try {
        return JSON.parse(text.value) as unknown;
      } catch (err) {
        toast(`The text is not valid JSON: ${(err as Error).message}`, 'error');
        return null;
      }
    };
    const run = async (body: Parameters<typeof gameApi.buildBlueprint>[1]) => {
      try {
        const a = await gameApi.buildBlueprint(scene, body);
        show(a);
        return a;
      } catch (err) {
        toast((err as Error).message, 'error');
        return null;
      }
    };
    const kits = first.kits ?? [];
    return h('div', { style: 'display:grid;grid-template-columns:minmax(320px,1fr) minmax(320px,1.4fr);gap:12px' },
      h('div', {}, text),
      h('div', {},
        plan,
        list,
        h('div', { style: 'display:flex;gap:8px;margin-top:10px;flex-wrap:wrap' },
          ...kits.map((kit) => h('button', { class: 'small', onclick: () => void run({ draftKit: kit }) }, `Draft with ${kit}`)),
          h('button', { class: 'small', onclick: () => { const blueprint = parsed(); if (blueprint) void run({ blueprint, dryRun: true }); } }, 'Check'),
          h('button', { class: 'small', onclick: async () => {
            const blueprint = parsed();
            if (!blueprint) return;
            const a = await run({ blueprint });
            if (a?.wrote) {
              close();
              location.reload();
            }
          } }, 'Compile into the map'),
        ),
      ),
    );
  }, { wide: true });
}
