import { formatBytes } from './format';
import type { ScanTree } from './tree';

/** How a CSV file is written; the interface supplies one per language. */
export interface CsvFormat {
  /** ";" for German Excel, "," for English. */
  separator: string;
  /** A byte order mark, so Excel reads the file as UTF-8 when it is opened by double-click. */
  bom: boolean;
  headers: {
    path: string;
    bytes: string;
    size: string;
    /** Size on disk, raw and formatted; only scans that know it (helper scans) get these columns. */
    allocatedBytes: string;
    allocated: string;
    files: string;
    folders: string;
    ext: string;
    modified: string;
  };
}

const BOM = '﻿';

function csv(format: CsvFormat, header: string[], rows: Array<Array<string | number>>): string {
  const sep = format.separator;
  const cell = (value: string | number) => {
    const text = String(value);
    return text.includes(sep) || /["\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return (format.bom ? BOM : '') + [header, ...rows].map((row) => row.map(cell).join(sep)).join('\r\n') + '\r\n';
}

function isoDate(ms: number): string {
  return ms > 0 ? new Date(ms).toISOString().slice(0, 10) : '';
}

/** Size and, when the scan knows it, size on disk: raw bytes and formatted. */
function sizeCells(tree: ScanTree, i: number): Array<string | number> {
  const cells: Array<string | number> = [tree.size(i), formatBytes(tree.size(i))];
  if (tree.hasAllocated) cells.push(tree.allocated(i), formatBytes(tree.allocated(i)));
  return cells;
}

function sizeHeaders(tree: ScanTree, format: CsvFormat): string[] {
  const h = format.headers;
  return tree.hasAllocated ? [h.bytes, h.size, h.allocatedBytes, h.allocated] : [h.bytes, h.size];
}

/** Every folder from `root` down, largest first within each folder. */
export function foldersCsv(tree: ScanTree, root: number, format: CsvFormat): string {
  const rows: Array<Array<string | number>> = [];
  const add = (i: number) => rows.push([tree.path(i), ...sizeCells(tree, i), tree.fileCount(i), tree.dirCount(i), isoDate(tree.mtime(i))]);
  const visit = (i: number) => {
    add(i);
    for (const c of tree.children(i)) if (tree.isDir(c)) visit(c);
  };
  visit(root);
  const h = format.headers;
  return csv(format, [h.path, ...sizeHeaders(tree, format), h.files, h.folders, h.modified], rows);
}

export function filesCsv(tree: ScanTree, files: readonly number[], format: CsvFormat): string {
  const rows = files.map((i) => [tree.path(i), ...sizeCells(tree, i), tree.ext(i), isoDate(tree.mtime(i))]);
  const h = format.headers;
  return csv(format, [h.path, ...sizeHeaders(tree, format), h.ext, h.modified], rows);
}

/** Lets the browser save `text` as a file. */
export function downloadText(filename: string, text: string, type = 'text/csv;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
