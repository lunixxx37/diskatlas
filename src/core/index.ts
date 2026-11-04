// Everything the user interface needs from the scanning and analysis code.

export { CATEGORIES, categoryOfExt, extOf, type Category, type CategoryId } from './categories';
export { ScanTree, type ScanMeta, type ScanSource } from './tree';
export type { ScanProgress } from './protocol';
export {
  dirHandleFromDrop,
  pickDirectory,
  scanDirectory,
  supportsDirectoryPicker,
  supportsFolderInput,
  treeFromFiles,
  type RunningScan,
} from './scanner';
export { createDemoTree, demoRootName, demoScan, type DemoLanguage } from './demo';
export {
  ageStats,
  categoryStats,
  extensionStats,
  topFiles,
  type AgeBucket,
  type AgeBucketId,
  type CategoryStat,
  type ExtensionStat,
} from './analysis';
export { layoutTreemap, squarify, type Rect, type TreemapKind, type TreemapOptions, type TreemapRect } from './treemap';
export {
  PATH_SEP,
  byteUnit,
  formatBytes,
  formatCount,
  formatDate,
  formatDateTime,
  formatDuration,
  formatLocale,
  formatPercent,
  setFormatLocale,
} from './format';
export { downloadText, filesCsv, foldersCsv, type CsvFormat } from './export';
