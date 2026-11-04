import { formatBytes, formatCount, formatPercent, type AgeBucket, type ScanTree } from '../../core';
import { h } from '../dom';
import { displayName } from '../format';
import { plural, t } from '../i18n';
import { tooltip, tooltipBody } from '../tooltip';
import type { AnalysisCache } from './analysis-cache';

/** Bar length as a fraction of the column; tiny non-zero values stay visible. */
const barFraction = (value: number, max: number): string => (value > 0 ? Math.max(0.006, value / max) : 0).toFixed(4);

/** One plain-language sentence about how old the data is. Exported for tests. */
export function ageInsight(buckets: AgeBucket[]): { text: string; bytes: number } {
  const known = buckets.filter((b) => b.fromDays !== null);
  const total = known.reduce((s, b) => s + b.size, 0);
  if (total <= 0) return { text: t.age.noDates, bytes: 0 };
  const olderThan = (days: number) => known.filter((b) => b.fromDays! >= days).reduce((s, b) => s + b.size, 0);
  const old2 = olderThan(730);
  if (old2 / total >= 0.2) return { text: t.age.old2(formatPercent(old2 / total)), bytes: old2 };
  const old1 = olderThan(365);
  if (old1 / total >= 0.2) return { text: t.age.old1(formatPercent(old1 / total)), bytes: old1 };
  const fresh = known.filter((b) => b.toDays !== null && b.toDays <= 182).reduce((s, b) => s + b.size, 0);
  return { text: t.age.fresh(formatPercent(fresh / total)), bytes: fresh };
}

/**
 * "File age": per age bucket, size and file count as two small bar charts side by
 * side, each on its own scale (never a dual axis). Ordered buckets take one sepia
 * ramp, newest light to oldest dark.
 */
export class FileAgePanel {
  readonly el: HTMLElement;
  private folder = -1;

  constructor(
    private readonly tree: ScanTree,
    private readonly cache: AnalysisCache,
  ) {
    this.el = h('div', { class: 'panel panel--age' });
  }

  update(folder: number): void {
    if (folder === this.folder) return;
    this.folder = folder;
    const buckets = this.cache.ages(folder);
    const totalSize = buckets.reduce((s, b) => s + b.size, 0);
    const totalCount = buckets.reduce((s, b) => s + b.count, 0);
    if (totalCount === 0) {
      this.el.replaceChildren(h('p', { class: 'panel__empty', text: t.panels.noFiles }));
      return;
    }
    const maxSize = Math.max(...buckets.map((b) => b.size), 1);
    const maxCount = Math.max(...buckets.map((b) => b.count), 1);
    const insight = ageInsight(buckets);

    const rows = buckets.map((b, k) => {
      const color = b.fromDays === null ? 'var(--age-unknown)' : `var(--age-${Math.min(6, k + 1)})`;
      const sizeShare = totalSize > 0 ? b.size / totalSize : 0;
      const countShare = b.count / totalCount;
      const row = h(
        'div',
        { class: 'agechart__row', role: 'row' },
        h('div', { class: 'agechart__label', role: 'rowheader', text: t.ages[b.id] }),
        h(
          'div',
          { class: 'agechart__cell', role: 'cell' },
          h('span', { class: 'agechart__bar', style: { '--w': barFraction(b.size, maxSize), '--bar': color } }),
          h('span', { class: 'agechart__value num', text: formatBytes(b.size) }),
        ),
        h(
          'div',
          { class: 'agechart__cell', role: 'cell' },
          h('span', { class: 'agechart__bar', style: { '--w': barFraction(b.count, maxCount), '--bar': color } }),
          h('span', { class: 'agechart__value num', text: formatCount(b.count) }),
        ),
      );
      row.addEventListener('pointermove', (event) =>
        tooltip.show(
          `age:${folder}:${k}`,
          () =>
            tooltipBody({
              value: formatBytes(b.size),
              share: t.age.ofSize(formatPercent(sizeShare)),
              title: t.ages[b.id],
              meta: t.age.meta(plural(b.count, t.files), formatPercent(countShare)),
              key: color,
            }),
          event.clientX,
          event.clientY,
        ),
      );
      row.addEventListener('pointerleave', () => tooltip.hide());
      return row;
    });

    this.el.replaceChildren(
      h(
        'header',
        { class: 'panel__intro' },
        h(
          'div',
          null,
          h('h3', { class: 'panel__title' }, t.age.title, h('span', { class: 'panel__where', text: displayName(this.tree, folder) })),
          h('p', { class: 'panel__lede', text: t.age.lede }),
        ),
      ),
      h(
        'p',
        { class: 'insight' },
        h('span', { class: 'insight__text', text: insight.text }),
        insight.bytes > 0 ? h('span', { class: 'insight__bytes num', text: formatBytes(insight.bytes) }) : null,
      ),
      h(
        'div',
        { class: 'agechart', role: 'table', 'aria-label': t.age.chart },
        h(
          'div',
          { class: 'agechart__row agechart__row--head', role: 'row' },
          h('span', { class: 'label', role: 'columnheader', text: t.age.colModified }),
          h('span', { class: 'label', role: 'columnheader', text: t.age.colSize }),
          h('span', { class: 'label', role: 'columnheader', text: t.age.colFiles }),
        ),
        ...rows,
      ),
      h('p', { class: 'panel__note', text: t.age.tip }),
    );
  }
}
