/** Git page: save versions of the game, browse them, compare, restore, and sync with a remote repository. */

import { type GitChange, type GitCommit, type GitStatus, gitApi } from './gameApi.js';
import { state } from './gameState.js';
import { appNav } from './nav.js';
import { flushAll } from './play.js';
import { clear, confirmDialog, h, icon, modal, promptText, toast } from './dom.js';

const PAGE_SIZE = 30;
const STATUS_LETTER = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' } as const;

const isSprite = (file: string) => file.endsWith('.sprite.json');

function compareSprites(title: string, file: GitChange, before: string, after: string): void {
  const side = (label: string, ref: string | null, name: string) => {
    const img = ref ? h('img', { class: 'pixel', src: gitApi.spriteUrl(ref, name), alt: `${label}: ${name}` }) : null;
    const none = h('span', { class: 'muted', hidden: !!ref }, 'Not in this version');
    img?.addEventListener('error', () => {
      img.hidden = true;
      none.hidden = false;
    });
    return h('figure', {}, h('figcaption', { class: 'muted small' }, label), img, none);
  };
  void modal(title, () => h('div', { class: 'git-compare' },
    side('Before', file.status === 'added' ? null : before, file.oldPath ?? file.path),
    side('After', file.status === 'deleted' ? null : after, file.path),
  ), { wide: true });
}

async function showTextDiff(title: string, file: GitChange, sha?: string): Promise<void> {
  try {
    const d = await gitApi.diff(file.path, sha);
    const all = d.text.split('\n');
    const lines = all.slice(Math.max(0, all.findIndex((l) => l.startsWith('@@'))));
    const lineClass = (l: string) => (l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : '');
    await modal(title, () => d.text
      ? h('div', {},
        h('pre', { class: 'git-diff' }, lines.map((l) => h('div', { class: lineClass(l) }, l || ' '))),
        d.truncated && h('p', { class: 'muted small' }, 'This diff is too long to show in full.'))
      : h('p', { class: 'muted' }, 'New file: there is no earlier version to compare.'), { wide: true });
  } catch (err) {
    toast((err as Error).message, 'error');
  }
}

export function renderGit(root: HTMLElement): () => void {
  clear(root);
  const body = h('main', { class: 'git-page' });
  root.append(h('div', { class: 'page' }, appNav('git'), body));

  const message = h('input', { type: 'text', placeholder: 'What changed in this version?', spellcheck: false, 'aria-label': 'Version message' });
  const commitBtn = h('button', { class: 'primary', type: 'submit' }, 'Save version');
  const form = h('form', { class: 'git-commit', onsubmit: (e: Event) => { e.preventDefault(); void commit(); } }, message, commitBtn);
  const bar = h('div', { class: 'git-bar' });
  const changesTitle = h('div', { class: 'side-title' }, 'Changes');
  const changes = h('div', { class: 'git-files' });
  const history = h('div', { class: 'git-history' });
  const shell = h('div', {}, bar, h('div', { class: 'git-cols' },
    h('section', {}, changesTitle, form, changes),
    h('section', {}, h('div', { class: 'side-title' }, 'History'), history),
  ));

  let shown = PAGE_SIZE;
  let renderedHead: string | null | undefined;
  let renderedShown = 0;
  let lastStatus: GitStatus | null = null;
  const openCommits = new Map<string, HTMLElement>();

  /** Runs an action with its button disabled, then reloads the page; failures become a toast. */
  const act = async (btn: HTMLButtonElement | null, fn: () => Promise<unknown>) => {
    if (btn) btn.disabled = true;
    try {
      await fn();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    if (btn) btn.disabled = false;
    await refresh();
  };

  async function commit(): Promise<void> {
    const text = message.value.trim();
    if (!text) {
      toast('Write a message describing this version', 'error');
      message.focus();
      return;
    }
    await act(commitBtn, async () => {
      await flushAll();
      const r = await gitApi.commit(text);
      message.value = '';
      toast(`Saved version ${r.sha.slice(0, 7)}`);
    });
  }

  const restore = async (c: GitCommit, file?: GitChange) => {
    const ok = await confirmDialog(
      file ? 'Restore this file?' : 'Restore this version?',
      `${file ? file.path : 'Every file of the game'} goes back to “${c.subject}”. Nothing is lost: unsaved work is stored as a version first, and the restore is a new version you can undo.`,
      'Restore',
    );
    if (!ok) return;
    await act(null, async () => {
      await flushAll();
      const r = await gitApi.restore(c.sha, file?.path);
      await state.load();
      toast(r.commit ? `Restored as version ${r.commit.slice(0, 7)}` : 'The files already match that version');
    });
  };

  const fileRow = (f: GitChange, open: () => void, extra?: Node) =>
    h('div', { class: 'git-file' },
      h('button', { class: 'git-file-open', title: 'Show what changed', onclick: open },
        h('span', { class: `git-status ${f.status}`, title: f.status }, STATUS_LETTER[f.status]),
        h('span', { class: 'git-path' }, f.oldPath ? `${f.oldPath} → ${f.path}` : f.path)),
      extra,
    );

  const renderChanges = (s: GitStatus) => {
    changesTitle.textContent = `Changes (${s.changes.length})`;
    clear(changes);
    if (!s.changes.length) changes.append(h('p', { class: 'muted git-none' }, 'No changes since the last version.'));
    for (const f of s.changes) {
      changes.append(fileRow(f, () => {
        if (isSprite(f.path)) compareSprites(f.path, f, 'HEAD', 'WORKTREE');
        else void showTextDiff(f.path, f);
      }));
    }
  };

  const renderBar = (s: GitStatus) => {
    clear(bar);
    const pushBtn: HTMLButtonElement = h('button', { class: 'small', disabled: !s.remote, onclick: () => void act(pushBtn, async () => { await gitApi.push(); toast('Pushed'); }) }, icon('up', 14), s.ahead ? `Push (${s.ahead})` : 'Push');
    const pullBtn: HTMLButtonElement = h('button', { class: 'small', disabled: !s.remote, onclick: () => void act(pullBtn, async () => { await gitApi.pull(); await state.load(); toast('Up to date'); }) }, icon('down', 14), s.behind ? `Pull (${s.behind})` : 'Pull');
    const setRemote = async () => {
      const url = await promptText('Remote repository', 'Address (leave empty to disconnect)', s.remote ?? '');
      if (url !== null) await act(null, () => gitApi.setRemote(url));
    };
    bar.append(
      h('span', { class: 'badge muted-badge' }, s.branch ?? 'detached'),
      h('span', { class: 'muted small git-remote', title: s.remote ?? '' }, s.remote ? `${s.remote}${s.pushed ? '' : ' · not pushed yet'}` : 'Only on this computer'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'small', onclick: () => void setRemote() }, s.remote ? 'Change remote' : 'Connect remote'),
      pullBtn,
      pushBtn,
    );
  };

  const commitFiles = async (c: GitCommit, target: HTMLElement) => {
    clear(target);
    try {
      const files = await gitApi.files(c.sha);
      if (!files.length) target.append(h('p', { class: 'muted git-none' }, 'No files changed.'));
      for (const f of files) {
        const restoreFile = f.status === 'deleted' ? undefined : h('button', { class: 'small', title: `Bring ${f.path} back to this version`, onclick: () => void restore(c, f) }, 'Restore file');
        target.append(fileRow(f, () => {
          if (isSprite(f.path)) compareSprites(`${f.path} · ${c.short}`, f, `${c.sha}^`, c.sha);
          else void showTextDiff(`${f.path} · ${c.short}`, f, c.sha);
        }, restoreFile));
      }
    } catch (err) {
      target.append(h('p', { class: 'muted git-none' }, (err as Error).message));
    }
  };

  const renderHistory = async () => {
    const log = await gitApi.log(shown + 1);
    const more = log.length > shown;
    clear(history);
    if (!log.length) history.append(h('p', { class: 'muted git-none' }, 'No versions yet.'));
    log.slice(0, shown).forEach((c, index) => {
      const files = h('div', { class: 'git-files', hidden: !openCommits.has(c.sha) });
      if (openCommits.has(c.sha)) {
        openCommits.set(c.sha, files);
        void commitFiles(c, files);
      }
      const toggle = () => {
        files.hidden = !files.hidden;
        if (files.hidden) openCommits.delete(c.sha);
        else {
          openCommits.set(c.sha, files);
          void commitFiles(c, files);
        }
      };
      history.append(h('article', { class: 'git-commit-row' },
        h('div', { class: 'git-commit-head' },
          h('button', { class: 'git-commit-open', title: 'Show the files of this version', onclick: toggle },
            h('span', { class: 'git-subject' }, c.subject),
            h('span', { class: 'muted small' }, `${c.short} · ${c.author} · ${new Date(c.time).toLocaleString()}`)),
          index > 0 && h('button', { class: 'small', title: 'Bring the whole game back to this version', onclick: () => void restore(c) }, 'Restore'),
        ),
        files,
      ));
    });
    if (more) history.append(h('button', { class: 'small git-more', onclick: () => { shown += PAGE_SIZE; void refresh(); } }, 'Show older versions'));
  };

  const renderEnable = (s: GitStatus) => {
    clear(body);
    const enableBtn: HTMLButtonElement = h('button', { class: 'primary', onclick: () => void act(enableBtn, () => gitApi.enable()) }, 'Enable version control');
    body.append(h('div', { class: 'empty big' },
      !s.installed ? [h('h2', {}, 'Git is not installed'), h('p', {}, 'Install git on this computer, then come back to this page.')]
      : s.parentRepo ? [h('h2', {}, 'Already versioned elsewhere'), h('p', {}, `The repository at ${s.parentRepo} already tracks this folder, so it can't have its own.`)]
      : [h('h2', {}, 'Keep every version of this game'), h('p', {}, 'Creates a git repository in the game folder, separate from the editor, with the game as it is now as its first version. Exports and generated files stay out.'), enableBtn],
    ));
  };

  let running = false;
  let again = false;
  async function refresh(): Promise<void> {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      const s = await gitApi.status();
      if (!s.enabled) {
        renderEnable(s);
        renderedHead = undefined;
      } else {
        if (!lastStatus?.enabled || body.firstChild !== shell) body.replaceChildren(shell);
        renderBar(s);
        renderChanges(s);
        if (renderedHead !== s.head || renderedShown !== shown) {
          await renderHistory();
          renderedHead = s.head;
          renderedShown = shown;
        }
      }
      lastStatus = s;
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      running = false;
      if (again) {
        again = false;
        void refresh();
      }
    }
  }

  void refresh();
  return () => void refresh();
}
