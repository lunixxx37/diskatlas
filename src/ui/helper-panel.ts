import { HELPER_DOWNLOAD_URL, HELPER_START_URL, formatBytes, formatPercent, type HelperDrive } from '../core';
import { append, clear, h, rich, setText, uniqueId, type Child } from './dom';
import type { HelperLink } from './helper-link';
import { t } from './i18n';
import { icon, type IconName } from './icons';

/**
 * The start page's section for whole drives and system folders: connect to the DiskAtlas
 * Helper, then survey a drive or any folder. It draws whatever state the HelperLink is in,
 * so it can be thrown away and rebuilt (language switch) without losing anything.
 */
export class HelperPanel {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private readonly live: HTMLElement;
  private readonly ids = uniqueId('helper');
  private lastAnnounced = '';
  private readonly onChange = () => this.render();

  constructor(
    private readonly link: HelperLink,
    /** A scan of `path` was started with `id`: show it. */
    private readonly onSurvey: (path: string, id: string) => void,
  ) {
    this.body = h('div', { class: 'helper__card' });
    this.live = h('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
    this.el = h(
      'section',
      { class: 'helper', id: 'helper', 'aria-labelledby': `${this.ids}-title` },
      h(
        'div',
        { class: 'helper__intro' },
        h('p', { class: 'eyebrow', text: t.helper.eyebrow }),
        h('h2', { class: 'helper__title', id: `${this.ids}-title`, text: t.helper.title }),
        h('p', { class: 'helper__lede', text: t.helper.lede }),
      ),
      this.body,
      this.live,
    );
    this.lastAnnounced = this.statusText();
    link.addEventListener('change', this.onChange);
    this.render();
  }

  destroy(): void {
    this.link.removeEventListener('change', this.onChange);
  }

  private render(): void {
    // Keep keyboard focus on the same control, or on the status line when that control is gone.
    const active = document.activeElement as HTMLElement | null;
    const hadFocus = !!active && this.body.contains(active);
    const key = hadFocus ? active.dataset.focus : undefined;
    this.body.dataset.status = this.link.status;
    clear(this.body);
    append(this.body, ...this.content());
    if (hadFocus) {
      const same = key ? this.body.querySelector<HTMLElement>(`[data-focus="${key}"]`) : null;
      (same && !(same as HTMLButtonElement).disabled ? same : this.body.querySelector<HTMLElement>('.helper__status'))?.focus({ preventScroll: true });
    }
    const text = this.statusText();
    if (text !== this.lastAnnounced) {
      this.lastAnnounced = text;
      setText(this.live, text);
    }
  }

  /** The one-line state, also announced to screen readers. */
  private statusText(): string {
    const { link } = this;
    switch (link.status) {
      case 'idle':
        return link.note === 'quit' ? t.helper.quitNote : '';
      case 'connecting':
        return t.helper.connecting;
      case 'waiting':
        return t.helper.waiting(String(link.waitLeft));
      case 'not-found':
        return link.note === 'lost' ? t.helper.lost : link.note === 'still-not-found' ? t.helper.stillNotFound : link.note === 'elevate-failed' ? t.helper.elevateFailed : t.helper.notFound;
      case 'denied':
        return t.helper.denied;
      case 'wrong-server':
        return t.helper.wrongServer;
      case 'elevating':
        return t.helper.elevating;
      case 'connected': {
        const head = `${t.helper.connected(link.client?.info.version ?? '')} · ${link.elevated ? t.helper.admin : t.helper.notAdmin}`;
        return link.note === 'declined' ? `${head}. ${t.helper.declined}` : link.note === 'elevate-failed' ? `${head}. ${t.helper.elevateFailed}` : head;
      }
    }
  }

  private content(): Child[] {
    switch (this.link.status) {
      case 'idle':
      case 'connecting':
        return this.idle();
      case 'not-found':
      case 'waiting':
        return this.notFound();
      case 'denied':
        return this.denied();
      case 'wrong-server':
        return [status('alert', t.helper.wrongServer, 'warn'), actions(this.retryButton())];
      case 'connected':
      case 'elevating':
        return this.connected();
    }
  }

  private idle(): Child[] {
    const connecting = this.link.status === 'connecting';
    const connect = button(connecting ? t.helper.connecting : t.helper.connect, 'plug', 'btn--secondary', 'connect', () => void this.link.connect());
    connect.disabled = connecting;
    return [
      connecting ? status('spinner', t.helper.connecting) : this.link.note === 'quit' ? status('check', t.helper.quitNote) : null,
      actions(connect),
      fine('info', t.helper.permissionNote),
    ];
  }

  private notFound(): Child[] {
    const { link } = this;
    const waiting = link.status === 'waiting';
    const start = h('a', { class: 'btn btn--primary', href: HELPER_START_URL, 'data-focus': 'start' }, icon('power'), t.helper.start);
    // The browser asks whether to open the helper; meanwhile look for it.
    start.addEventListener('click', () => void link.startAndWait());
    const download = h('a', { class: 'btn btn--secondary', href: HELPER_DOWNLOAD_URL, 'data-focus': 'download' }, icon('download'), t.helper.download);
    const headline =
      link.note === 'lost' ? t.helper.lost : link.note === 'still-not-found' ? t.helper.stillNotFound : link.note === 'elevate-failed' ? t.helper.elevateFailed : t.helper.notFound;
    return [
      waiting ? status('spinner', t.helper.waiting(String(link.waitLeft))) : status('alert', headline, 'warn'),
      h('p', { class: 'helper__text', text: t.helper.notFoundText }),
      actions(start, download, this.retryButton(waiting)),
      fine('info', t.helper.firstRun, ...[' ', ...rich(t.helper.smartScreen)]),
    ];
  }

  private denied(): Child[] {
    return [
      status('lock', t.helper.denied, 'warn'),
      h('ol', { class: 'helper__steps' }, ...t.helper.deniedSteps.map((step) => h('li', null, ...rich(step)))),
      actions(this.retryButton()),
    ];
  }

  private retryButton(disabled = false): HTMLButtonElement {
    const retry = button(t.helper.retry, 'refresh', 'btn--ghost', 'retry', () => void this.link.connect());
    retry.disabled = disabled;
    return retry;
  }

  private connected(): Child[] {
    const { link } = this;
    const elevating = link.status === 'elevating';
    const tools: HTMLElement[] = [];
    if (!link.elevated) {
      const elevate = button(t.helper.elevate, 'shield', 'btn--ghost btn--sm', 'elevate', () => void link.elevate());
      elevate.disabled = elevating;
      tools.push(elevate);
    }
    const quit = button(t.helper.quit, 'power', 'btn--ghost btn--sm', 'quit', () => void link.quit());
    quit.disabled = elevating;
    tools.push(quit);

    const head = h(
      'div',
      { class: 'helper__bar' },
      elevating
        ? status('spinner', t.helper.elevating)
        : status('dot', `${t.helper.connected(link.client?.info.version ?? '')} · ${link.elevated ? t.helper.admin : t.helper.notAdmin}`, 'ok'),
      h('div', { class: 'helper__tools' }, ...tools),
    );
    const notes: Child[] = [];
    if (link.note === 'declined') notes.push(fine('info', t.helper.declined));
    if (link.note === 'elevate-failed') notes.push(fine('alert', t.helper.elevateFailed));
    if (!link.elevated && !elevating) notes.push(fine('shield', t.helper.elevateNote));
    return [head, ...notes, this.driveList(elevating), this.pathForm(elevating)];
  }

  private driveList(busy: boolean): HTMLElement {
    const { link } = this;
    const listId = `${this.ids}-drives`;
    let content: Child;
    if (link.drives === null) content = h('p', { class: 'helper__text' }, link.drivesFailed ? t.helper.drivesFailed : t.helper.loadingDrives);
    else if (link.drives.length === 0) content = h('p', { class: 'helper__text', text: t.helper.noDrives });
    else content = h('ul', { class: 'drives', 'aria-labelledby': listId }, ...link.drives.map((d) => this.driveRow(d, busy)));
    return h('div', { class: 'helper__drives' }, h('h3', { class: 'label', id: listId, text: t.helper.drives }), content);
  }

  private driveRow(drive: HelperDrive, busy: boolean): HTMLElement {
    const letter = drive.path.replace(/[\\/]+$/, '');
    const survey = button(t.helper.survey, null, 'btn--secondary btn--sm', `drive:${drive.path}`, () => void this.survey(drive.path));
    survey.setAttribute('aria-label', t.helper.surveyDrive(letter));
    survey.disabled = busy || !drive.ready || this.link.starting;
    const meta = [drive.fileSystem, t.helper.driveType[drive.type] ?? t.helper.driveType.unknown].filter(Boolean).join(' · ');
    let usage: HTMLElement;
    if (!drive.ready || drive.totalBytes <= 0) {
      usage = h('span', { class: 'drive__numbers', text: t.helper.notReady });
    } else {
      const used = Math.min(1, Math.max(0, (drive.totalBytes - drive.freeBytes) / drive.totalBytes));
      usage = h(
        'div',
        { class: 'drive__usage' },
        h(
          'span',
          { class: 'drive__bar', role: 'img', 'aria-label': t.helper.used(formatPercent(used)), 'data-full': used >= 0.9 ? 'true' : 'false' },
          h('span', { class: 'drive__fill', style: { width: `${(used * 100).toFixed(1)}%` } }),
        ),
        h('span', { class: 'drive__numbers num', text: t.helper.free(formatBytes(drive.freeBytes), formatBytes(drive.totalBytes)) }),
      );
    }
    return h(
      'li',
      { class: 'drive', 'data-ready': String(drive.ready) },
      icon('drive', 'drive__icon'),
      h(
        'div',
        { class: 'drive__main' },
        h('span', { class: 'drive__name' }, h('strong', { class: 'mono', text: letter }), drive.label ? h('span', { text: drive.label }) : null),
        h('span', { class: 'drive__meta', text: meta || t.helper.driveType.unknown }),
      ),
      usage,
      survey,
    );
  }

  private pathForm(busy: boolean): HTMLElement {
    const { link } = this;
    const inputId = `${this.ids}-path`;
    const hintId = `${inputId}-hint`;
    const errorId = `${inputId}-error`;
    const problem = link.pathProblem;
    const input = h('input', {
      class: 'text-input mono',
      id: inputId,
      type: 'text',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: t.helper.pathPlaceholder,
      'aria-describedby': problem ? `${errorId} ${hintId}` : hintId,
      'aria-invalid': problem ? 'true' : 'false',
      'data-focus': 'path',
    });
    input.value = link.draftPath;
    input.addEventListener('input', () => {
      link.draftPath = input.value;
    });
    const go = h('button', { class: 'btn btn--secondary', type: 'submit', 'data-focus': 'path-go', disabled: busy || link.starting }, icon('folderScan'), t.helper.survey);
    const form = h(
      'form',
      { class: 'helper__path', novalidate: true },
      h('label', { class: 'label', for: inputId, text: t.helper.pathLabel }),
      h('div', { class: 'helper__path-row' }, input, go),
      problem ? h('p', { class: 'helper__error', id: errorId, role: 'alert' }, icon('alert'), t.helper.pathError[problem]) : null,
      h('p', { class: 'helper__fine', id: hintId, text: t.helper.pathHint }),
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.survey(input.value, true);
    });
    return form;
  }

  private async survey(path: string, typed = false): Promise<void> {
    const id = await this.link.startScan(path, typed);
    if (id) {
      this.onSurvey(path.trim(), id);
    } else if (typed) {
      this.body.querySelector<HTMLInputElement>('[data-focus="path"]')?.focus();
    }
  }
}

function button(label: string, iconName: IconName | null, kind: string, focus: string, onClick: () => void): HTMLButtonElement {
  const b = h('button', { class: `btn ${kind}`, type: 'button', 'data-focus': focus }, iconName ? icon(iconName) : null, label);
  b.addEventListener('click', onClick);
  return b;
}

function actions(...children: Child[]): HTMLElement {
  return h('div', { class: 'helper__actions' }, ...children);
}

type Tone = 'warn' | 'ok' | undefined;

/** The state's headline; it takes focus when the button that was clicked disappears. */
function status(kind: IconName | 'spinner' | 'dot', text: string, tone?: Tone): HTMLElement {
  const mark = kind === 'spinner' ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : kind === 'dot' ? h('span', { class: 'helper__dot', 'aria-hidden': 'true' }) : icon(kind);
  return h('p', { class: 'helper__status', tabindex: '-1', 'data-tone': tone ?? '' }, mark, h('span', { text }));
}

function fine(iconName: IconName, ...text: Child[]): HTMLElement {
  return h('p', { class: 'helper__fine' }, icon(iconName), h('span', null, ...text));
}
