import { formatBytes, formatDate, formatPercent, type ScanTree } from '../../core';
import { entryButtons, type EntryActions } from '../cleanup';
import { h } from '../dom';
import { displayName, folderBelow, splitPath } from '../format';
import { t } from '../i18n';
import { icon } from '../icons';
import type { AnalysisCache } from './analysis-cache';
import { categoryVar } from './colors';

export interface TopFilesOptions {
  tree: ScanTree;
  cache: AnalysisCache;
  /** Show the file in the folder tree. */
  onReveal: (entry: number) => void;
  onExport: (folder: number) => void;
  /** Show in Explorer / Move to Recycle Bin per row (helper scans); null otherwise. */
  actions?: EntryActions | null;
}

/** "Largest files": the 100 largest files anywhere below the current folder. */
export class TopFilesPanel {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private readonly title: HTMLElement;
  private folder = -1;

  constructor(private readonly options: TopFilesOptions) {
    this.title = h('h3', { class: 'panel__title' });
    const exportButton = h('button', { class: 'btn btn--secondary btn--sm', type: 'button' }, icon('download'), t.top.exportCsv);
    exportButton.addEventListener('click', () => options.onExport(this.folder));
    this.body = h('div', { class: 'panel__body' });
    this.el = h(
      'div',
      { class: 'panel panel--top' },
      h('header', { class: 'panel__intro' }, h('div', null, this.title, h('p', { class: 'panel__lede', text: t.top.lede })), exportButton),
      this.body,
    );
    this.body.addEventListener('click', (event) => {
      const row = (event.target as Element).closest<HTMLElement>('tr[data-entry]');
      if (row) options.onReveal(Number(row.dataset.entry));
    });
  }

  update(folder: number): void {
    if (folder === this.folder) return;
    this.folder = folder;
    const { tree, cache } = this.options;
    const actions = this.options.actions ?? null;
    const files = cache.topFiles(folder);
    this.title.replaceChildren(
      files.length >= 100 ? t.top.title100 : t.top.title,
      h('span', { class: 'panel__where', text: displayName(tree, folder) }),
    );
    if (files.length === 0) {
      this.body.replaceChildren(h('p', { class: 'panel__empty', text: t.panels.noFiles }));
      return;
    }
    const total = tree.size(folder);
    const rows = files.map((i, k) => {
      const size = tree.size(i);
      const share = total > 0 ? size / total : 0;
      const where = folderBelow(tree, i, folder);
      const [head, tail] = splitPath(where);
      const name = displayName(tree, i);
      return h(
        'tr',
        { 'data-entry': String(i) },
        h('td', { class: 'c-rank num', text: String(k + 1) }),
        h(
          'td',
          { class: 'c-name' },
          h(
            'div',
            { class: 'cell-name' },
            h('span', { class: 'swatch', style: { '--cat': categoryVar(tree.categoryIndex(i)) } }),
            h('button', { class: 'cell-name__button', type: 'button', title: t.top.select(name), text: name }),
            // Online-only files (helper scans): big, yet nothing of them is on this PC.
            tree.cloud(i) ? h('span', { class: 'cell-flag', title: t.flags.cloud }, icon('cloud'), h('span', { class: 'sr-only', text: t.flags.cloud })) : null,
          ),
          h('div', { class: 'cell-sub mono', text: where || t.top.rightHere }),
        ),
        h('td', { class: 'c-num num', text: formatBytes(size) }),
        h(
          'td',
          { class: 'c-share' },
          h('span', { class: 'share' }, h('span', { class: 'share__fill', style: { width: `${Math.max(1.5, share * 100)}%` } })),
          h('span', { class: 'share__pct num', text: formatPercent(share) }),
        ),
        h(
          'td',
          { class: 'c-folder' },
          where ? h('span', { class: 'mtrunc mono', title: where }, h('span', { class: 'mtrunc__head', text: head }), h('span', { class: 'mtrunc__tail', text: tail })) : h('span', { class: 'muted', text: t.top.rightHere }),
        ),
        h('td', { class: 'c-date num', text: formatDate(tree.mtime(i)) }),
        actions ? h('td', { class: 'c-actions' }, entryButtons(actions, tree, i)) : null,
      );
    });
    this.body.replaceChildren(
      h(
        'table',
        { class: 'datatable datatable--files' },
        h('caption', { class: 'sr-only', text: t.top.caption(displayName(tree, folder)) }),
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', { class: 'c-rank', scope: 'col', text: t.top.colRank }),
            h('th', { class: 'c-name', scope: 'col', text: t.top.colName }),
            h('th', { class: 'c-num', scope: 'col', text: t.top.colSize }),
            h('th', { class: 'c-share', scope: 'col', text: t.top.colShare }),
            h('th', { class: 'c-folder', scope: 'col', text: t.top.colFolder }),
            h('th', { class: 'c-date', scope: 'col', text: t.top.colModified }),
            actions ? h('th', { class: 'c-actions', scope: 'col' }, h('span', { class: 'sr-only', text: t.cleanup.menu })) : null,
          ),
        ),
        h('tbody', null, ...rows),
      ),
    );
  }
}
