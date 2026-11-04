// Line icons on a 24 px grid, drawn with the current text colour. Static path data only.

const PATHS = {
  folder: ['M3.5 6A1.5 1.5 0 0 1 5 4.5h4.2l2 2.2H19a1.5 1.5 0 0 1 1.5 1.5V18a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18z'],
  folderOpen: [
    'M3.5 17.5V6A1.5 1.5 0 0 1 5 4.5h4.2l2 2.2H17a1.5 1.5 0 0 1 1.5 1.5v2.3',
    'M3.6 18.4l2.2-6.6a1.5 1.5 0 0 1 1.4-1h13.3a.8.8 0 0 1 .8 1.1l-2.2 6.5a1.5 1.5 0 0 1-1.4 1.1H4.4a.8.8 0 0 1-.8-1.1z',
  ],
  folderScan: [
    'M10.5 19.5H5A1.5 1.5 0 0 1 3.5 18V6A1.5 1.5 0 0 1 5 4.5h4.2l2 2.2H19a1.5 1.5 0 0 1 1.5 1.5v3.3',
    'M17 21a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
    'M17 11.5v1.5M17 21v1.5M12.5 17h1.5M20 17h1.5',
  ],
  file: ['M6.5 3.5h7l4 4v12a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z', 'M13.5 3.5v4h4'],
  chevron: ['M9.5 6.5l5.5 5.5-5.5 5.5'],
  chevronDown: ['M6.5 9.5l5.5 5.5 5.5-5.5'],
  refresh: ['M19.5 12a7.5 7.5 0 1 1-2.2-5.3', 'M19.5 4.5v4h-4'],
  download: ['M12 4.5v10', 'M7.5 10.5L12 15l4.5-4.5', 'M5 19.5h14'],
  copy: ['M10 9h8.5a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1H10a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1z', 'M15 9V5.5a1 1 0 0 0-1-1H5.5a1 1 0 0 0-1 1V14a1 1 0 0 0 1 1H9'],
  lock: ['M7.5 10.5V8a4.5 4.5 0 0 1 9 0v2.5', 'M6.5 10.5h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z'],
  layers: ['M12 4l8.5 4.5L12 13 3.5 8.5z', 'M3.5 12.5L12 17l8.5-4.5', 'M3.5 16.5L12 21l8.5-4.5'],
  sun: [
    'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
    'M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4',
  ],
  moon: ['M19.5 14.2A8 8 0 1 1 9.8 4.5a6.3 6.3 0 0 0 9.7 9.7z'],
  monitor: ['M4.5 5h15a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z', 'M9 20h6M12 16.5V20'],
  shield: ['M12 3.5l7 2.8v5.2c0 4.3-2.9 7.6-7 9-4.1-1.4-7-4.7-7-9V6.3z', 'M9 12l2 2 4-4'],
  user: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4.5 20a7.5 7.5 0 0 1 15 0'],
  tag: ['M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7l8.3 8.3a1 1 0 0 1 0 1.4l-7.1 7.1a1 1 0 0 1-1.4 0z', 'M8 8h.01'],
  info: ['M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17z', 'M12 11v5', 'M12 7.8v.01'],
  alert: ['M10.3 4.6L2.9 17.5a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.6a2 2 0 0 0-3.4 0z', 'M12 9.5v4', 'M12 17v.01'],
  levelUp: ['M9 4.5L4.5 9 9 13.5', 'M4.5 9H14a5.5 5.5 0 0 1 5.5 5.5v5'],
  arrowRight: ['M4.5 12h15', 'M13.5 6l6 6-6 6'],
  crosshair: ['M12 19a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  close: ['M6.5 6.5l11 11M17.5 6.5l-11 11'],
  map: ['M3.5 6.5l5.5-2 6 2 5.5-2v13l-5.5 2-6-2-5.5 2z', 'M9 4.5v13M15 6.5v13'],
  list: ['M9 6.5h10.5M9 12h10.5M9 17.5h10.5', 'M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01'],
  pie: ['M11 4a8.5 8.5 0 1 0 9 9h-9z', 'M14 3.6A8.5 8.5 0 0 1 20.4 10H14z'],
  clock: ['M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17z', 'M12 7.5V12l3 2'],
  tree: ['M5 4.5h5M8 4.5v13a1 1 0 0 0 1 1h3M8 11.5h4', 'M15 11.5h4.5M15 18.5h4.5'],
  link: ['M10.5 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1', 'M13.5 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1'],
  cloud: ['M7.5 18.5h10a4 4 0 0 0 .4-8 6 6 0 0 0-11.5-1.4A4.75 4.75 0 0 0 7.5 18.5z'],
  plug: ['M9 3.5v4M15 3.5v4', 'M6.5 7.5h11v2.5a5.5 5.5 0 0 1-11 0z', 'M12 15.5v5'],
  drive: ['M4.5 13.5l2.1-7.2a1.5 1.5 0 0 1 1.4-1.1h8a1.5 1.5 0 0 1 1.4 1.1l2.1 7.2', 'M4.5 13.5h15V18a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18z', 'M16.5 16.5h.01'],
  power: ['M12 3.5v8', 'M7.4 6.4a7 7 0 1 0 9.2 0'],
  trash: ['M4.5 7h15', 'M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2', 'M6.5 7l1 12a1.5 1.5 0 0 0 1.5 1.4h6a1.5 1.5 0 0 0 1.5-1.4l1-12', 'M10 11v6M14 11v6'],
  duplicate: ['M9 3.5h6l3.5 3.5v9.5a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1z', 'M15 3.5V7h3.5', 'M5.5 7.5v12a1 1 0 0 0 1 1h8.5'],
  /** Delete permanently: the bin, crossed out inside. */
  trashX: ['M4.5 7h15', 'M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2', 'M6.5 7l1 12a1.5 1.5 0 0 0 1.5 1.4h6a1.5 1.5 0 0 0 1.5-1.4l1-12', 'M9.8 11.3l4.4 4.4M14.2 11.3l-4.4 4.4'],
  home: ['M3.5 11L12 4l8.5 7', 'M6 9.2V19a1 1 0 0 0 1 1h3.5v-5.5h3V20H17a1 1 0 0 0 1-1V9.2'],
  minus: ['M6.5 12h11'],
} as const;

export type IconName = keyof typeof PATHS;

const SVG_NS = 'http://www.w3.org/2000/svg';

export function icon(name: IconName, className?: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (className) svg.setAttribute('class', className);
  for (const d of PATHS[name]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

/** The wordmark's glyph: a tiny treemap with one measured (accent) parcel. */
export function brandGlyph(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'wordmark__glyph');
  const parts: Array<[number, number, number, number, string]> = [
    [1, 1, 9.5, 18, 'var(--ink)'],
    [12, 1, 7, 9.5, 'var(--ink)'],
    [12, 12, 3, 7, 'var(--ink-2)'],
    [16.5, 12, 2.5, 7, 'var(--accent)'],
  ];
  for (const [x, y, w, h, fill] of parts) {
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(y));
    rect.setAttribute('width', String(w));
    rect.setAttribute('height', String(h));
    rect.setAttribute('rx', '1');
    rect.style.fill = fill;
    svg.appendChild(rect);
  }
  return svg;
}
