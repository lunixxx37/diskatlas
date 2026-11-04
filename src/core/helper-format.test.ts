import { afterEach, describe, expect, it } from 'vitest';
import { foldersCsv, filesCsv, type CsvFormat } from './export';
import { setFormatLocale } from './format';
import { buildHelperResult, sectionOffsets, type ResultSpec } from './helper-format.fixture';
import { HelperFormatError, decodeHelperResult } from './helper-format';
import { ScanTree, TreeBuilder, transferablesOf, type ScanMeta } from './tree';

const META: ScanMeta = { rootName: '', source: 'helper', startedAt: 0, durationMs: 0, complete: true };
const GB = 1024 ** 3;

function decode(buffer: ArrayBuffer): ScanTree {
  const builder = decodeHelperResult(buffer);
  return new ScanTree(builder.finish({ ...META, rootName: builder.names[0] }));
}

function find(tree: ScanTree, name: string): number {
  for (let i = 0; i < tree.count; i++) if (tree.name(i) === name) return i;
  throw new Error(`no entry ${name}`);
}

/** A drive root with a link, a cloud file and a folder that could not be listed. Not sorted. */
const drive = (): ResultSpec => ({
  names: ['C:', 'Users', 'pagefile.sys', 'Ann', 'notes.txt', 'My Music', 'film.mp4', 'System Volume Information', 'big.iso'],
  parent: [-1, 0, 0, 1, 3, 3, 3, 0, 3],
  kind: [1, 1, 0, 1, 0, 1 | 4, 8, 1 | 2, 0],
  size: [0, 0, 8 * GB, 0, 1000, 0, 2 * GB, 0, 5 * GB],
  mtime: [0, 0, 1_700_000_000_000, 0, 1_700_000_100_000, 0, 1_600_000_000_000, 0, 1_650_000_000_000],
  allocated: [0, 0, 8 * GB, 0, 4096, 0, 0, 0, 5 * GB],
});

describe('helper result decoder', () => {
  it('reads names, parents, kinds, sizes and dates into a tree', () => {
    const tree = decode(buildHelperResult(drive()));
    expect(tree.count).toBe(9);
    expect(tree.name(0)).toBe('C:');
    expect(tree.meta.rootName).toBe('C:');
    const notes = find(tree, 'notes.txt');
    expect(tree.path(notes, '\\')).toBe('C:\\Users\\Ann\\notes.txt');
    expect(tree.size(0)).toBe(8 * GB + 1000 + 2 * GB + 5 * GB);
    expect(tree.mtime(notes)).toBe(1_700_000_100_000);
    expect(tree.fileCount(0)).toBe(4);
    expect(tree.dirCount(0)).toBe(4);
    // Unsorted in the buffer; largest first in the tree.
    expect([...tree.children(find(tree, 'Ann'))].map((i) => tree.name(i))).toEqual(['big.iso', 'film.mp4', 'notes.txt', 'My Music']);
  });

  it('maps the kind bits to folders and flags', () => {
    const tree = decode(buildHelperResult(drive()));
    const link = find(tree, 'My Music');
    expect(tree.isDir(link)).toBe(true);
    expect(tree.link(link)).toBe(true);
    expect(tree.childCount(link)).toBe(0);
    expect(tree.cloud(find(tree, 'film.mp4'))).toBe(true);
    expect(tree.isDir(find(tree, 'film.mp4'))).toBe(false);
    expect(tree.unreadable(find(tree, 'System Volume Information'))).toBe(true);
    expect(tree.unreadable(find(tree, 'Ann'))).toBe(false);
    expect(tree.link(find(tree, 'Ann')) || tree.cloud(find(tree, 'Ann'))).toBe(false);
    expect(decodeHelperResult(buildHelperResult(drive())).errors).toBe(1);
  });

  it('adds up sizes on disk for folders when the result has them', () => {
    const tree = decode(buildHelperResult(drive()));
    expect(tree.hasAllocated).toBe(true);
    expect(tree.allocated(find(tree, 'notes.txt'))).toBe(4096);
    expect(tree.allocated(find(tree, 'film.mp4'))).toBe(0);
    expect(tree.allocated(find(tree, 'Ann'))).toBe(4096 + 5 * GB);
    expect(tree.allocated(0)).toBe(8 * GB + 4096 + 5 * GB);
  });

  it('works without the allocated section', () => {
    const spec = drive();
    delete spec.allocated;
    const tree = decode(buildHelperResult(spec));
    expect(tree.hasAllocated).toBe(false);
    expect(tree.allocated(0)).toBe(0);
    expect(tree.size(0)).toBe(15 * GB + 1000);
  });

  it('finds every section after any amount of padding', () => {
    // Root names of 2..10 bytes and 1..9 entries move each section through all 8 alignments.
    for (let extra = 0; extra <= 8; extra++) {
      for (let files = 0; files <= 8; files++) {
        const names = [`C:${'x'.repeat(extra)}`, ...Array.from({ length: files }, (_, k) => `f${k}.bin`)];
        const spec: ResultSpec = {
          names,
          parent: names.map((_, i) => (i === 0 ? -1 : 0)),
          kind: names.map((_, i) => (i === 0 ? 1 : 0)),
          size: names.map((_, i) => (i === 0 ? 0 : i * 10)),
          mtime: names.map((_, i) => i * 1000),
          allocated: names.map((_, i) => (i === 0 ? 0 : 4096 * i)),
        };
        const buffer = buildHelperResult(spec);
        const at = sectionOffsets(new TextEncoder().encode(names.join('\0')).length, names.length);
        for (const offset of Object.values(at)) expect(offset % 8).toBe(0);
        expect(buffer.byteLength).toBe(at.allocated + 8 * names.length);
        const tree = decode(buffer);
        expect(tree.name(0)).toBe(names[0]);
        expect(tree.size(0)).toBe(((files * (files + 1)) / 2) * 10);
        expect(tree.allocated(0)).toBe(((files * (files + 1)) / 2) * 4096);
        if (files > 0) expect(tree.name(tree.children(0)[0])).toBe(`f${files - 1}.bin`);
      }
    }
  });

  it('puts no padding before a section that already starts on a multiple of 8', () => {
    // 8 bytes of names: the parent section starts right at 32.
    const at = sectionOffsets(8, 2);
    expect(at.parent).toBe(32);
    expect(at.kind).toBe(40);
    expect(at.size).toBe(48);
    const tree = decode(buildHelperResult({ names: ['C:', 'abcde'], parent: [-1, 0], kind: [1, 0], size: [0, 7], mtime: [0, 0] }));
    expect(tree.name(1)).toBe('abcde');
    expect(tree.size(0)).toBe(7);
  });

  it('keeps a folder path as the root name', () => {
    const tree = decode(buildHelperResult({ names: ['C:\\Users\\Ann', 'Documents', 'cv.pdf'], parent: [-1, 0, 1], kind: [1, 1, 0], size: [0, 0, 300], mtime: [0, 0, 5] }));
    expect(tree.name(0)).toBe('C:\\Users\\Ann');
    expect(tree.path(2, '\\')).toBe('C:\\Users\\Ann\\Documents\\cv.pdf');
  });

  it('decodes UTF-8 names exactly', () => {
    const names = ['D:', 'Fotos – Größe', '音楽', '🎵 mix.flac', 'Cafe\u0301.txt', '\uFEFFbom.txt', 'e\u0301'];
    const tree = decode(
      buildHelperResult({
        names,
        parent: [-1, 0, 0, 2, 1, 1, 1],
        kind: [1, 1, 1, 0, 0, 0, 0],
        size: [0, 0, 0, 4, 3, 2, 1],
        mtime: [0, 0, 0, 0, 0, 0, 0],
      }),
    );
    for (const name of names) expect(find(tree, name)).toBeGreaterThanOrEqual(0);
    expect(tree.path(find(tree, '🎵 mix.flac'), '\\')).toBe('D:\\音楽\\🎵 mix.flac');
  });

  it('ignores folder sizes in the result and adds them up itself', () => {
    const tree = decode(buildHelperResult({ names: ['C:', 'a', 'x'], parent: [-1, 0, 1], kind: [1, 1, 0], size: [999, 555, 10], mtime: [0, 0, 0], allocated: [7, 7, 4096] }));
    expect(tree.size(0)).toBe(10);
    expect(tree.size(1)).toBe(10);
    expect(tree.allocated(0)).toBe(4096);
  });
});

describe('malformed helper results', () => {
  const small = (): ResultSpec => ({ names: ['C:', 'a', 'b.txt'], parent: [-1, 0, 1], kind: [1, 1, 0], size: [0, 0, 5], mtime: [0, 0, 1], allocated: [0, 0, 4096] });
  const rejects = (spec: Partial<ResultSpec>, message: RegExp) => {
    const buffer = buildHelperResult({ ...small(), ...spec });
    expect(() => decodeHelperResult(buffer)).toThrow(HelperFormatError);
    expect(() => decodeHelperResult(buffer)).toThrow(message);
  };

  it('rejects anything shorter than the header', () => {
    expect(() => decodeHelperResult(new ArrayBuffer(12))).toThrow(/shorter than the 24-byte header/);
  });

  it('rejects a wrong magic, version or header flag', () => {
    rejects({ magic: 'DAH2' }, /does not start with "DAH1"/);
    rejects({ magic: 'XXXX' }, /does not start with "DAH1"/);
    rejects({ version: 2 }, /format version 2 is not supported/);
    rejects({ flags: 3 }, /unknown header flags 0x3/);
  });

  it('rejects lengths that do not match the header', () => {
    rejects({ count: 0 }, /no entries/);
    rejects({ count: 4 }, /expected \d+ bytes for 4 entries/);
    rejects({ truncate: 8 }, /expected \d+ bytes for 3 entries/);
    rejects({ trailing: 8 }, /expected \d+ bytes for 3 entries/);
    rejects({ namesLength: 10_000 }, /run past the end/);
    rejects({ flags: 0 }, /expected \d+ bytes/);
  });

  it('rejects names that do not fit the entries', () => {
    rejects({ rawNames: new TextEncoder().encode('C:\0a\0b.txt\0') }, /expected 3 names, found 4/);
    rejects({ rawNames: new TextEncoder().encode('C:\0ab.txt') }, /expected 3 names, found 2/);
    rejects({ rawNames: new Uint8Array([0x43, 0x3a, 0, 0xff, 0xfe, 0, 0x62]) }, /not valid UTF-8/);
  });

  it('rejects parents that are missing, later, or files', () => {
    rejects({ parent: [0, 0, 1] }, /root's parent is 0/);
    rejects({ parent: [-1, 2, 0] }, /entry 1 has parent 2/);
    rejects({ parent: [-1, 0, -1] }, /entry 2 has parent -1/);
    rejects({ parent: [-1, 0, 7] }, /entry 2 has parent 7/);
    rejects({ kind: [1, 0, 0] }, /entry 2 has parent 1, which is a file/);
  });

  it('rejects unknown kinds and a root that is not a folder', () => {
    rejects({ kind: [1, 1, 16] }, /unknown kind bits 0x10/);
    rejects({ kind: [0, 1, 0] }, /root is not a folder/);
  });

  it('rejects sizes and dates that are not numbers', () => {
    rejects({ size: [0, 0, -1] }, /entry 2 has size -1/);
    rejects({ size: [0, 0, Number.NaN] }, /entry 2 has size NaN/);
    rejects({ size: [0, 0, Number.POSITIVE_INFINITY] }, /entry 2 has size Infinity/);
    rejects({ mtime: [0, 0, Number.NaN] }, /modification time NaN/);
    rejects({ allocated: [0, 0, -4096] }, /size on disk -4096/);
  });
});

describe('sizes on disk', () => {
  afterEach(() => setFormatLocale('de-DE'));

  it('are added up for folders by the builder', () => {
    const b = new TreeBuilder({ allocated: true });
    const root = b.addDir(-1, 'D:');
    const a = b.addDir(root, 'a');
    b.addFile(a, 'x.bin', 100, 1, 4096);
    b.addFile(a, 'y.bin', 5000, 1, 8192);
    b.addFile(root, 'z.bin', 1, 1, 4096);
    const data = b.finish(META);
    const tree = new ScanTree(data);
    expect(tree.allocated(root)).toBe(16384);
    expect(tree.allocated(a)).toBe(12288);
    expect(tree.size(root)).toBe(5101);
    expect(transferablesOf(data)).toContain(data.allocated!.buffer);
  });

  it('are absent from scans that do not record them', () => {
    const b = new TreeBuilder();
    const root = b.addDir(-1, 'Photos');
    b.addFile(root, 'a.jpg', 100, 1, 4096);
    const data = b.finish(META);
    expect(data.allocated).toBeUndefined();
    expect(new ScanTree(data).hasAllocated).toBe(false);
    expect(transferablesOf(data)).toHaveLength(9);
  });

  it('get their own CSV columns', () => {
    setFormatLocale('en-US');
    const tree = decode(buildHelperResult(drive()));
    const format: CsvFormat = {
      separator: ',',
      bom: false,
      headers: { path: 'Path', bytes: 'Size (bytes)', size: 'Size', allocatedBytes: 'Size on disk (bytes)', allocated: 'Size on disk', files: 'Files', folders: 'Folders', ext: 'Extension', modified: 'Last modified' },
    };
    const folders = foldersCsv(tree, 0, format).split('\r\n');
    expect(folders[0]).toBe('Path,Size (bytes),Size,Size on disk (bytes),Size on disk,Files,Folders,Last modified');
    expect(folders[1].startsWith(`C:,${15 * GB + 1000},15.0 GB,${13 * GB + 4096},13.0 GB,4,4,`)).toBe(true);
    const files = filesCsv(tree, [find(tree, 'film.mp4')], format).split('\r\n');
    expect(files[0]).toBe('Path,Size (bytes),Size,Size on disk (bytes),Size on disk,Extension,Last modified');
    expect(files[1]).toMatch(/,2147483648,2\.00 GB,0,0 bytes,mp4,2020-09-13$/);
  });
});
