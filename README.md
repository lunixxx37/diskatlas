# DiskAtlas

**See what's filling your storage.** DiskAtlas surveys a folder or a whole drive and maps it, right in your browser. Nothing is installed and nothing is uploaded.

> Status: in development, not released yet.

## Features

- **Folder tree** with size, share, number of files and last change, fast even for hundreds of thousands of entries
- **Map** (treemap): every area is as large as the space it takes up; click a folder to zoom in, hover to see it highlighted in the tree
- **Largest files**, **file types** by category and extension, and **file age**
- **Possible duplicates**: files with the same name and size, grouped by the space you could free
- **CSV export** of folders and files
- **Read-only in the browser**: the website never changes anything. With the helper you can also show items in Explorer and move them to the Recycle Bin or delete them permanently, always after confirming
- Light and dark theme, English and German
- An example drive to try it without picking a folder

## Privacy

DiskAtlas runs entirely on your device. The scan reads only names, sizes and modification dates, never file contents. There are no cookies, no tracking and no requests to other servers: fonts are bundled, and a strict Content Security Policy blocks connections to any other host.

## Browser support

| Browser | Support |
| --- | --- |
| Chrome, Edge and other Chromium browsers | Full: pick a folder or drag it onto the page |
| Firefox, Safari | Limited: the folder is read through the browser's standard folder dialog |

Browsers protect some system locations and won't open them, for example the root of drive `C:\`, the Windows and program folders, and AppData. Other drives and your own folders work. For the protected locations there is the DiskAtlas Helper (below). Sizes are the logical file sizes, as Windows Explorer shows them (1 KB = 1,024 bytes).

## DiskAtlas Helper (Windows)

An optional small program for what the browser can't open: whole drives such as `C:\` and system folders. It has no window and closes itself when it hasn't been used for a while. With it, DiskAtlas also shows the size on disk and marks links and OneDrive online-only files. Restarted as administrator, it can read protected folders too.

Scanning only reads. The helper changes something only after you confirm it on the website: it moves an item to the Recycle Bin, or deletes it permanently if you explicitly choose that and confirm again. It always refuses system locations and never follows links while deleting.

The helper listens only on `127.0.0.1` (ports 41417–41419) and answers only the DiskAtlas website. [docs/helper-protocol.md](docs/helper-protocol.md) describes the protocol.

Building it requires Go 1.25 or newer:

```bash
cd helper
go test ./...
go build -trimpath -ldflags "-H=windowsgui -s -w -X main.version=0.1.0" -o bin/DiskAtlas-Helper.exe .
```

While working on the website with `npm run dev`, start it with `bin/DiskAtlas-Helper.exe --dev --serve --no-open`.

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
- `helper`: the DiskAtlas Helper for Windows, in Go

## Deutsch

DiskAtlas zeigt, was deinen Speicher füllt: Ordner und Laufwerke werden direkt im Browser vermessen, ohne Installation und ohne Upload. Die Oberfläche gibt es auf Deutsch und Englisch.

## License

[MIT](LICENSE)
