import { de, en, type DemoNames } from './demo-names';
import type { ScanProgress } from './protocol';
import type { RunningScan } from './scanner';
import { FLAG_UNREADABLE, ScanTree, TreeBuilder } from './tree';

// A made-up drive (about 15,000 entries, 700 GB), so the app can be tried without
// granting access to any real folder. All names are invented; they come in the
// interface's languages (see demo-names.ts), the layout and the sizes do not change.

/** Language of the demo drive's folder and file names. */
export type DemoLanguage = 'en' | 'de';

const NAMES: Record<DemoLanguage, DemoNames> = { en, de };

const KB = 1024;
const MB = 1024 ** 2;
const GB = 1024 ** 3;
const DAY = 86_400_000;
const YIELD_EVERY = 300;

/** Installed size of each game in GB, in the order of `DemoNames.gameList`. */
const GAME_GB = [92, 71, 44, 36, 18, 9];
const LIBRARIES = ['engine', 'physics', 'audio', 'render_dx12', 'render_vk', 'net', 'ui', 'steam_api64', 'video', 'scripting', 'crashpad', 'fonts', 'input', 'compress', 'anim', 'locale'];
/** Year of each trip, in the order of `DemoNames.trips`. */
const TRIP_YEARS = [2023, 2022, 2025, 2021];
const PACKAGES = ['react', 'react-dom', 'scheduler', 'typescript', 'esbuild', 'rollup', 'postcss', 'autoprefixer', 'tailwindcss', 'lodash', 'date-fns', 'zod', 'axios', 'chalk', 'commander', 'debug', 'ms', 'semver', 'glob', 'minimatch', 'picomatch', 'fast-glob', 'yaml', 'acorn', 'magic-string', 'source-map', 'nanoid', 'eslint', 'prettier', 'vitest', 'chai', 'tinybench', 'undici', 'ws', 'cookie', 'mime', 'qs', 'uuid', 'dotenv', 'colorette'];
/** Size range of each big download, in the order of `DemoNames.downloadList`. */
const DOWNLOAD_SIZES: Array<[min: number, max: number]> = [
  [4.6 * GB, 5.2 * GB],
  [5.4 * GB, 6.1 * GB],
  [5.8 * GB, 6.4 * GB],
  [1.5 * GB, 3.8 * GB],
  [600 * MB, 900 * MB],
  [300 * MB, 1.1 * GB],
  [900 * MB, 1.6 * GB],
  [200 * MB, 600 * MB],
  [2.5 * GB, 4.5 * GB],
  [2 * MB, 9 * MB],
];
/** Extension and size range of the small leftovers, in the order of `DemoNames.leftovers`. */
const LEFTOVERS: Array<[ext: string, min: number, max: number]> = [
  ['pdf', 50 * KB, 8 * MB],
  ['jpg', 300 * KB, 6 * MB],
  ['exe', 2 * MB, 150 * MB],
  ['pdf', 40 * KB, 400 * KB],
  ['zip', 1 * MB, 400 * MB],
];
/** File types in each document folder, in the order of `DemoNames.documentFolders`. */
const DOCUMENT_EXTS = [['pdf', 'pdf', 'xlsx'], ['pdf'], ['docx', 'pdf'], ['pdf', 'docx', 'pptx', 'xlsx'], ['pdf', 'docx', 'jpg']];

function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

function stamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Fills `b` with the demo drive. Yields every few hundred entries, so it can be played back slowly. */
function* populate(b: TreeBuilder, now: number, names: DemoNames): Generator<void, void, unknown> {
  const rnd = random(20261103);
  const between = (a: number, z: number) => a + rnd() * (z - a);
  const logBetween = (a: number, z: number) => Math.exp(between(Math.log(a), Math.log(z)));
  const int = (a: number, z: number) => Math.floor(between(a, z + 1));
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)];
  const daysAgo = (from: number, to: number) => now - between(from, to) * DAY;
  const dir = (parent: number, name: string) => b.addDir(parent, name);
  const file = (parent: number, name: string, size: number, mtime: number) =>
    b.addFile(parent, name, Math.round(size), Math.min(now, Math.round(mtime)));
  let nextYield = YIELD_EVERY;
  const due = () => {
    if (b.count < nextYield) return false;
    nextYield = b.count + YIELD_EVERY;
    return true;
  };

  const root = dir(-1, names.root);

  // Games: a few huge archives each, plus thousands of tiny shader caches.
  const steamapps = dir(dir(dir(root, names.games), 'SteamLibrary'), 'steamapps');
  const common = dir(steamapps, 'common');
  for (const [g, game] of names.gameList.entries()) {
    const folder = dir(common, game.name);
    const installed = daysAgo(20, 900);
    file(folder, `${game.exe}.exe`, logBetween(40 * MB, 180 * MB), installed);
    for (const lib of LIBRARIES.slice(0, int(6, LIBRARIES.length))) {
      file(folder, `${lib}.dll`, logBetween(200 * KB, 60 * MB), installed);
    }
    const content = dir(folder, 'Content');
    const paks = dir(content, 'Paks');
    let left = GAME_GB[g] * GB * 0.9;
    for (let k = 0; left > 0; k++) {
      const size = Math.min(left, logBetween(0.6 * GB, 9 * GB));
      file(paks, `pakchunk${k}-Windows.pak`, size, installed);
      left -= size;
    }
    const movies = dir(content, 'Movies');
    for (let k = 1, n = int(3, 8); k <= n; k++) {
      file(movies, `cinematic_${pad(k)}.webm`, logBetween(40 * MB, 900 * MB), installed);
    }
    const shaders = dir(folder, 'ShaderCache');
    for (let k = 0, n = int(150, 600); k < n; k++) {
      file(shaders, `${Math.floor(rnd() * 2 ** 32).toString(16).padStart(8, '0')}.bin`, logBetween(4 * KB, 2 * MB), daysAgo(1, 60));
      if (due()) yield;
    }
    const saves = dir(folder, 'Saves');
    for (let k = 1, n = int(2, 12); k <= n; k++) file(saves, `slot_${k}.sav`, logBetween(100 * KB, 20 * MB), daysAgo(1, 200));
  }
  const shaderCache = dir(steamapps, 'shadercache');
  for (let k = 0; k < 800; k++) {
    file(shaderCache, `fozpipelines_${pad(k, 4)}.foz`, logBetween(8 * KB, 6 * MB), daysAgo(1, 120));
    if (due()) yield;
  }
  dir(steamapps, 'downloading');
  file(steamapps, 'libraryfolders.vdf', 2 * KB, daysAgo(1, 10));

  // Videos: holiday clips, screen recordings, films.
  const videos = dir(root, names.videos);
  for (const [t, name] of names.trips.entries()) {
    const year = TRIP_YEARS[t];
    const folder = dir(videos, name);
    const start = new Date(year, int(0, 10), int(1, 25)).getTime();
    for (let k = 0, n = int(15, 40); k < n; k++) {
      const taken = start + between(0, 14) * DAY;
      file(folder, `VID_${stamp(taken)}.mp4`, logBetween(50 * MB, 1.5 * GB), taken);
    }
    if (due()) yield;
  }
  const recordings = dir(videos, names.recordings);
  for (let k = 0, n = int(8, 14); k < n; k++) {
    const recorded = daysAgo(3, 500);
    file(recordings, `stream_${stamp(recorded)}.mkv`, logBetween(1.5 * GB, 9 * GB), recorded);
  }
  const films = dir(videos, names.films);
  for (const film of names.filmList) {
    const added = daysAgo(30, 2200);
    file(films, `${film}.mkv`, logBetween(3 * GB, 16 * GB), added);
    if (rnd() < 0.6) file(films, `${film}.srt`, logBetween(40 * KB, 120 * KB), added);
  }

  // Photos: one folder per year and month, JPEGs and some RAW files.
  const photos = dir(root, names.photos);
  const today = new Date(now);
  let counter = 1000;
  for (let year = 2017; year <= today.getFullYear(); year++) {
    const yearFolder = dir(photos, String(year));
    const lastMonth = year === today.getFullYear() ? today.getMonth() : 11;
    for (let month = 0; month <= lastMonth; month++) {
      if (rnd() > 0.7) continue;
      const monthFolder = dir(yearFolder, `${year}-${pad(month + 1)}`);
      for (let k = 0, n = int(15, 110); k < n; k++) {
        const taken = new Date(year, month, 1).getTime() + between(0, 27) * DAY;
        counter++;
        file(monthFolder, `IMG_${counter}.jpg`, logBetween(1.8 * MB, 9 * MB), taken);
        if (rnd() < 0.25) file(monthFolder, `IMG_${counter}.cr3`, logBetween(22 * MB, 34 * MB), taken);
        if (due()) yield;
      }
    }
  }

  // Music.
  const music = dir(root, names.music);
  for (const artist of names.artists) {
    const artistFolder = dir(music, artist);
    const albums = names.albums.slice(int(0, names.albums.length - 4)).slice(0, int(1, 4));
    for (const album of albums) {
      const albumFolder = dir(artistFolder, album);
      const lossless = rnd() < 0.55;
      const added = daysAgo(60, 3000);
      for (let t = 1, n = int(8, 14); t <= n; t++) {
        file(
          albumFolder,
          `${pad(t)} ${pick(names.songs)}.${lossless ? 'flac' : 'mp3'}`,
          lossless ? logBetween(20 * MB, 50 * MB) : logBetween(5 * MB, 12 * MB),
          added,
        );
      }
      file(albumFolder, 'cover.jpg', logBetween(200 * KB, 2 * MB), added);
    }
    if (due()) yield;
  }

  // Projects: a website with node_modules and a game engine with build output.
  const projects = dir(root, names.projects);
  const site = dir(projects, names.website);
  const modules = dir(site, 'node_modules');
  for (const pkg of PACKAGES) {
    const pkgFolder = dir(modules, pkg);
    const touched = daysAgo(5, 400);
    file(pkgFolder, 'package.json', logBetween(1 * KB, 6 * KB), touched);
    file(pkgFolder, 'README.md', logBetween(2 * KB, 40 * KB), touched);
    file(pkgFolder, 'LICENSE', 1.1 * KB, touched);
    const dist = dir(pkgFolder, 'dist');
    for (let k = 0, n = int(5, 60); k < n; k++) {
      file(dist, `chunk-${k}.${pick(['js', 'js', 'mjs', 'cjs'])}`, logBetween(1 * KB, 400 * KB), touched);
      file(dist, `chunk-${k}.d.ts`, logBetween(500, 30 * KB), touched);
    }
    if (due()) yield;
  }
  const src = dir(site, 'src');
  for (let k = 0; k < 60; k++) file(src, `${names.component}-${k}.${pick(['ts', 'tsx', 'css'])}`, logBetween(1 * KB, 30 * KB), daysAgo(0, 90));
  const git = dir(site, '.git');
  file(dir(dir(git, 'objects'), 'pack'), 'pack-3f9a1c.pack', logBetween(80 * MB, 300 * MB), daysAgo(1, 30));
  file(git, 'index', logBetween(200 * KB, 900 * KB), daysAgo(0, 5));

  const engine = dir(projects, names.engine);
  const build = dir(dir(engine, 'build'), 'Debug');
  for (let k = 0; k < 300; k++) {
    file(build, `${names.module}_${pad(k, 3)}.obj`, logBetween(100 * KB, 5 * MB), daysAgo(2, 40));
    if (due()) yield;
  }
  for (const name of ['engine.pdb', 'editor.pdb', 'tests.pdb']) file(build, name, logBetween(200 * MB, 1.2 * GB), daysAgo(2, 40));
  file(build, 'editor.exe', logBetween(30 * MB, 60 * MB), daysAgo(2, 40));
  const assets = dir(engine, 'assets');
  const textures = dir(assets, names.textures);
  for (let k = 0; k < 200; k++) file(textures, `tex_${pad(k, 3)}.png`, logBetween(1 * MB, 20 * MB), daysAgo(10, 700));
  const sounds = dir(assets, 'sounds');
  for (let k = 0; k < 80; k++) file(sounds, `sfx_${pad(k, 3)}.wav`, logBetween(1 * MB, 30 * MB), daysAgo(10, 700));
  if (due()) yield;

  // Downloads: a few big installers and disk images, many small leftovers.
  const downloads = dir(root, 'Downloads');
  for (const [d, name] of names.downloadList.entries()) {
    const [min, max] = DOWNLOAD_SIZES[d];
    file(downloads, name, logBetween(min, max), daysAgo(2, 900));
  }
  for (let k = 1; k <= 110; k++) {
    const kind = Math.floor(rnd() * LEFTOVERS.length);
    const [ext, min, max] = LEFTOVERS[kind];
    file(downloads, `${names.leftovers[kind]} (${k}).${ext}`, logBetween(min, max), daysAgo(1, 1500));
  }
  if (due()) yield;

  // Backups: three of the biggest files on the drive.
  const backups = dir(root, names.backups);
  file(backups, `${names.phoneBackup} 2025-08.zip`, 38.4 * GB, daysAgo(430, 440));
  file(backups, `${names.phoneBackup} 2026-09.zip`, 46.2 * GB, daysAgo(40, 50));
  file(backups, names.systemImage, 118.6 * GB, daysAgo(640, 660));
  const oldDisk = dir(backups, names.oldDisk);
  for (let f = 0; f < 3; f++) {
    const folder = dir(oldDisk, names.documentFolders[f]);
    for (let k = 0; k < 120; k++) file(folder, `${names.oldFile}_${k}.${pick(DOCUMENT_EXTS[f])}`, logBetween(30 * KB, 12 * MB), daysAgo(1900, 3200));
    if (due()) yield;
  }

  // Documents.
  const documents = dir(root, names.documents);
  for (const [f, name] of names.documentFolders.entries()) {
    const folder = dir(documents, name);
    const stem = name.replaceAll(' ', '_');
    for (let k = 0, n = int(80, 220); k < n; k++) {
      file(folder, `${stem}_${pad(k, 3)}.${pick(DOCUMENT_EXTS[f])}`, logBetween(30 * KB, 15 * MB), daysAgo(1, 2500));
    }
    if (due()) yield;
  }
  file(root, names.notes, 12 * KB, daysAgo(0, 3));

  // System folders as they appear on a real drive; one of them cannot be read.
  const bin = dir(root, '$RECYCLE.BIN');
  for (let k = 0; k < 24; k++) file(bin, `$R${Math.floor(rnd() * 2 ** 24).toString(36).toUpperCase()}.tmp`, logBetween(1 * MB, 900 * MB), daysAgo(1, 60));
  b.flag(dir(root, 'System Volume Information'), FLAG_UNREADABLE);
}

/** Name of the demo drive's top folder. */
export function demoRootName(lang: DemoLanguage = 'de'): string {
  return NAMES[lang].root;
}

/** The demo drive, right away. */
export function createDemoTree(now = Date.now(), lang: DemoLanguage = 'de'): ScanTree {
  const names = NAMES[lang];
  const t0 = performance.now();
  const builder = new TreeBuilder();
  const steps = populate(builder, now, names);
  while (!steps.next().done) {
    // Run to the end.
  }
  return new ScanTree(
    builder.finish({ rootName: names.root, source: 'demo', startedAt: now, durationMs: performance.now() - t0, complete: true }),
  );
}

/** Plays back a scan of the demo drive with progress reports, taking about `durationMs`. */
export function demoScan(
  onProgress: (progress: ScanProgress) => void,
  durationMs = 2400,
  lang: DemoLanguage = 'de',
): RunningScan {
  const names = NAMES[lang];
  const now = Date.now();
  let total = 0;
  const counting = populate(new TreeBuilder(), now, names);
  while (!counting.next().done) total++;

  const builder = new TreeBuilder();
  const steps = populate(builder, now, names);
  const t0 = performance.now();
  let cancelled = false;

  const result = new Promise<ScanTree>((resolve) => {
    let taken = 0;
    const tick = () => {
      const elapsed = performance.now() - t0;
      const target = cancelled ? taken : Math.ceil((elapsed / durationMs) * (total + 1));
      let finished = false;
      while (taken < target) {
        if (steps.next().done) {
          finished = true;
          break;
        }
        taken++;
      }
      onProgress({
        files: builder.files,
        dirs: builder.dirs,
        bytes: builder.bytes,
        errors: builder.errors,
        currentPath: builder.pathOf(builder.lastDir),
        elapsedMs: elapsed,
      });
      if (finished || cancelled) {
        resolve(
          new ScanTree(
            builder.finish({ rootName: names.root, source: 'demo', startedAt: now, durationMs: elapsed, complete: finished }),
          ),
        );
      } else {
        setTimeout(tick, 50);
      }
    };
    setTimeout(tick, 50);
  });

  return {
    result,
    cancel: () => {
      cancelled = true;
    },
  };
}
