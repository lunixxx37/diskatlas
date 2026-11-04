# DiskAtlas

**See what's filling your storage.** DiskAtlas surveys a folder or a whole drive and maps it, right in your browser. Nothing is installed and nothing is uploaded.

> Status: in development, not released yet.

## Features

- **Folder tree** with size, share, number of files and last change, fast even for hundreds of thousands of entries
- **Map** (treemap): every area is as large as the space it takes up; click a folder to zoom in, hover to see it highlighted in the tree
- **Largest files**, **file types** by category and extension, and **file age**
- **CSV export** of folders and files
- **Read-only**: DiskAtlas never changes or deletes anything
- Light and dark theme, English and German
- An example drive to try it without picking a folder

## Privacy

DiskAtlas runs entirely on your device. The scan reads only names, sizes and modification dates, never file contents. There are no cookies, no tracking and no requests to other servers: fonts are bundled, and a strict Content Security Policy blocks connections to any other host.

## Browser support

| Browser | Support |
| --- | --- |
| Chrome, Edge and other Chromium browsers | Full: pick a folder or drag it onto the page |
| Firefox, Safari | Limited: the folder is read through the browser's standard folder dialog |

Browsers protect some system locations and won't open them, for example the root of drive `C:\`, the Windows and program folders, and AppData. Other drives and your own folders work. Sizes are the logical file sizes, as Windows Explorer shows them (1 KB = 1,024 bytes).

## Development

Requires Node.js 22 or newer.

```bash
npm ci
npm run dev      # http://localhost:5173, add ?demo for the example drive
npm test
npm run build    # static site in dist/
```

The code is plain TypeScript without a UI framework:

- `src/core`: scanning in a Web Worker via the File System Access API, the tree model, treemap layout, analyses, formatting and CSV export
- `src/ui`: views and components
- `src/styles`: CSS with design tokens

## Deutsch

DiskAtlas zeigt, was deinen Speicher füllt: Ordner und Laufwerke werden direkt im Browser vermessen, ohne Installation und ohne Upload. Die Oberfläche gibt es auf Deutsch und Englisch.

## License

[MIT](LICENSE)
