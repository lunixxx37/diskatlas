import { APP_NAME } from './brand';
import { h, rich } from './dom';
import { createHeroMap } from './hero-map';
import { t } from './i18n';
import { icon } from './icons';

/** What this browser can do: open folders directly, take a folder's files, or neither. */
export type Support = 'picker' | 'files' | 'none';

export interface StartViewOptions {
  support: Support;
  onPick: () => void;
  onDemo: () => void;
  /** Open "Good to know" right away (it was open before the language changed). */
  knowOpen?: boolean;
}

export class StartView {
  readonly el: HTMLElement;
  private readonly zone: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly idleHint: string;
  private readonly know: HTMLDetailsElement;

  constructor(options: StartViewOptions) {
    const { support } = options;
    this.idleHint = support === 'picker' ? t.start.dragHint : t.start.pickHint;

    const pickButton = h(
      'button',
      { class: 'btn btn--primary btn--lg', type: 'button', disabled: support === 'none' },
      icon('folderOpen'),
      t.start.pick,
    );
    pickButton.addEventListener('click', options.onPick);

    this.hint = h('p', { class: 'dropzone__hint', text: this.idleHint });
    this.zone = h(
      'div',
      { class: 'dropzone corners', 'data-state': 'idle' },
      h('div', { class: 'dropzone__inner' }, icon('folderScan', 'dropzone__icon'), pickButton, this.hint),
    );

    const demoButton = h('button', { class: 'btn btn--secondary', type: 'button' }, icon('map'), t.start.demo);
    demoButton.addEventListener('click', options.onDemo);

    const intro = h(
      'div',
      { class: 'start__intro' },
      h('p', { class: 'eyebrow', text: t.start.eyebrow }),
      h('h1', { class: 'start__title', tabindex: '-1' }, t.start.title),
      h('p', { class: 'start__lede' }, t.start.lede(APP_NAME)),
      this.zone,
      h('div', { class: 'start__secondary' }, demoButton, h('p', { class: 'start__fine', text: t.start.fine })),
      supportNote(support),
    );

    const figure = h(
      'figure',
      { class: 'hero-map' },
      createHeroMap('wide'),
      createHeroMap('compact'),
      h('figcaption', { class: 'hero-map__caption', text: t.start.caption }),
    );

    this.know = goodToKnow();
    this.know.open = options.knowOpen ?? false;
    this.el = h(
      'main',
      { class: 'view view--start', id: 'main' },
      h('section', { class: 'start', 'aria-labelledby': 'start-title' }, intro, figure),
      trustRow(),
      this.know,
    );
    intro.querySelector('h1')!.id = 'start-title';
  }

  get knowOpen(): boolean {
    return this.know.open;
  }

  /** Highlights the drop zone while something is dragged over the page. */
  setDragOver(over: boolean): void {
    this.zone.dataset.state = over ? 'over' : 'idle';
    this.hint.textContent = over ? t.start.dropHint : this.idleHint;
  }

  destroy(): void {
    // Nothing to release: no timers or listeners outside this element.
  }
}

function supportNote(support: Support): HTMLElement | null {
  if (support === 'picker') return null;
  if (support === 'files') {
    return h(
      'div',
      { class: 'support-note', role: 'note' },
      icon('info'),
      h('p', null, h('strong', { text: t.start.limitedTitle }), t.start.limitedText),
    );
  }
  return h(
    'div',
    { class: 'support-note support-note--warn', role: 'note' },
    icon('alert'),
    h('p', null, h('strong', { text: t.start.unsupportedTitle }), t.start.unsupportedText),
  );
}

function trustRow(): HTMLElement {
  const { trust } = t.start;
  const items: Array<[Parameters<typeof icon>[0], { title: string; text: string }]> = [
    ['shield', trust.device],
    ['user', trust.account],
    ['tag', trust.free],
  ];
  return h(
    'ul',
    { class: 'trust', 'aria-label': t.start.trustLabel },
    ...items.map(([name, item]) =>
      h('li', { class: 'trust__item' }, icon(name), h('div', null, h('strong', { text: item.title }), h('span', { text: item.text }))),
    ),
  );
}

function goodToKnow(): HTMLDetailsElement {
  return h(
    'details',
    { class: 'know' },
    h(
      'summary',
      { class: 'know__summary' },
      icon('chevron', 'know__chevron'),
      h('span', { class: 'know__title', text: t.start.knowTitle }),
      h('span', { class: 'know__teaser', text: t.start.knowTeaser }),
    ),
    h('div', { class: 'know__body' }, h('ul', { class: 'know__list' }, ...t.start.know.map((item) => h('li', null, ...rich(item))))),
  );
}
