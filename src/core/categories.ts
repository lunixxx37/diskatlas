export type CategoryId =
  | 'video'
  | 'image'
  | 'audio'
  | 'archive'
  | 'program'
  | 'document'
  | 'code'
  | 'data'
  | 'other';

export interface Category {
  id: CategoryId;
}

/**
 * The order is fixed: a category's position is its index in per-category arrays.
 * Display names live in the interface's message catalogs, keyed by id.
 */
export const CATEGORIES: readonly Category[] = [
  { id: 'video' },
  { id: 'image' },
  { id: 'audio' },
  { id: 'archive' },
  { id: 'program' },
  { id: 'document' },
  { id: 'code' },
  { id: 'data' },
  { id: 'other' },
];

export const OTHER_INDEX = CATEGORIES.length - 1;

const EXTENSIONS: Record<Exclude<CategoryId, 'other'>, string> = {
  video: 'mp4 m4v mkv avi mov wmv webm flv mpg mpeg m2ts mts vob 3gp ogv',
  image: 'jpg jpeg png gif bmp tif tiff webp heic heif avif raw cr2 cr3 nef arw dng orf rw2 psd xcf svg ico',
  audio: 'mp3 wav flac aac ogg oga m4a wma opus aiff aif mid midi',
  archive: 'zip rar 7z tar gz tgz bz2 xz zst lz4 cab iso img vhd vhdx vmdk dmg wim esd',
  program: 'exe dll msi msix appx sys drv ocx so dylib app apk jar com scr',
  document: 'pdf doc docx odt rtf txt md xls xlsx ods csv ppt pptx odp epub one msg eml',
  code: 'js mjs cjs ts tsx jsx py c h cpp hpp cc cs java kt go rs swift html htm css scss json xml yml yaml toml ini sh bat ps1 php rb lua sql vue svelte',
  data: 'pak vpk bsa ba2 upk uasset ucas utoc assets bundle resource ress dat db sqlite sqlite3 mdb bin cache log tmp bak pdb wad big arc forge',
};

const INDEX_BY_EXT = new Map<string, number>();
for (const [id, list] of Object.entries(EXTENSIONS)) {
  const index = CATEGORIES.findIndex((c) => c.id === id);
  for (const ext of list.split(' ')) INDEX_BY_EXT.set(ext, index);
}

/** Lower-case extension without the dot, or '' (also for dotfiles such as ".gitignore"). */
export function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '';
}

export function categoryIndexOfExt(ext: string): number {
  return INDEX_BY_EXT.get(ext) ?? OTHER_INDEX;
}

export function categoryOfExt(ext: string): CategoryId {
  return CATEGORIES[categoryIndexOfExt(ext)].id;
}
