# DiskAtlas Helper protocol (v1)

The DiskAtlas Helper is a small Windows program without a window. It lets the website survey what the browser can't open: whole drives such as `C:\`, system folders, and the space files take up on disk.

Scanning only reads. The helper changes files in exactly one case: when the user confirms on the website that an item should go to the Recycle Bin (see `/v1/recycle`). It never deletes anything permanently by itself.

The website talks to it over HTTP on the loopback interface. This document is the contract between the two sides: `helper/` (Go) and `src/core/helper*.ts` (TypeScript).

## Transport

- HTTP/1.1, bound to `127.0.0.1` only (never `0.0.0.0` or another interface).
- Port: the first free one of **41417, 41418, 41419**. The website probes them in this order.
- All paths start with `/v1/`. Responses carry `Cache-Control: no-store`.
- JSON responses use `Content-Type: application/json; charset=utf-8`. Field names are camelCase.

The website only sends *simple* CORS requests, so the browser never needs a preflight:

- `GET` without custom headers.
- `POST` with a `text/plain;charset=UTF-8` body that contains JSON. The helper parses the body as JSON whatever its content type, and an empty body counts as `{}`.

The helper still answers `OPTIONS` (see below), so other clients and later versions can use preflights.

## Security

Every request, `OPTIONS` included, passes these checks before anything else happens:

1. **Host**: must be `127.0.0.1:<port>` or `localhost:<port>` for the port the helper listens on. Anything else gets `403` with no CORS headers. This blocks DNS rebinding.
2. **Origin**: must be present and exactly equal (scheme, host and port) to an allowed origin. Anything else, including a missing Origin, gets `403` with no CORS headers. Because browsers always send `Origin` on cross-origin requests, this also stops other websites from triggering side effects with simple POSTs.

Allowed origins:

- Always: the production origin `https://lunixxx37.github.io` (set at build time, see "Build").
- With `--dev`: also `http://localhost:5173` and `http://127.0.0.1:5173`.
- Each `--origin <origin>` adds one more.

Every response to an allowed request carries:

```
Access-Control-Allow-Origin: <the request's Origin>
Vary: Origin
```

`OPTIONS` from an allowed origin returns `204` with `Access-Control-Allow-Methods: GET, POST`, `Access-Control-Allow-Headers: Content-Type` and `Access-Control-Max-Age: 600`. If the request has `Access-Control-Request-Private-Network: true`, the response also has `Access-Control-Allow-Private-Network: true`.

Browser side (Chrome 142 and later): the first request from a public site to `127.0.0.1` shows the "Loopback network" (earlier "Local network") permission prompt. The website therefore:

- sends the first request only after the user clicks something;
- passes `targetAddressSpace: 'loopback'` to `fetch`;
- reads the state with `navigator.permissions.query({ name: 'loopback-network' })` inside try/catch, treating an error as `'prompt'`. It never queries `'local-network-access'`, which crashes older Chrome renderers;
- makes every helper request from the page itself, not from a worker;
- explains how to allow access in the site settings again after a denial, because a denied fetch fails with a `TypeError` and the browser does not ask again.

## Errors

Any 4xx or 5xx response from an allowed origin has this JSON body:

```json
{ "error": { "code": "not_found", "message": "Human-readable English text" } }
```

| HTTP | `code` | When |
| --- | --- | --- |
| 403 | `forbidden` | Host or Origin refused. Browsers can't read this body, because it has no CORS headers |
| 400 | `bad_request` | invalid JSON, a body over 64 KiB, or a missing, relative or device path (`\\.\…`, `\\?\Volume{…}`) |
| 404 | `not_found` | unknown endpoint, unknown scan id, or the path does not exist |
| 409 | `not_a_directory` | the path is a file |
| 409 | `scan_running` | a result was requested before the scan finished |
| 500 | `internal` | anything unexpected |

## Endpoints

### `GET /v1/info`

```json
{
  "app": "diskatlas-helper",
  "version": "0.1.0",
  "protocol": 1,
  "os": "windows",
  "arch": "amd64",
  "elevated": false,
  "pid": 4242,
  "idleTimeoutSeconds": 600,
  "features": ["scan", "reveal", "recycle"]
}
```

The website treats a server as the helper only if `app` is `"diskatlas-helper"` and `protocol` is `1`. It offers an action only if `features` lists it. A helper without `features` counts as `["scan"]`.

### `GET /v1/drives`

```json
{
  "drives": [
    {
      "path": "C:\\",
      "label": "Windows",
      "fileSystem": "NTFS",
      "type": "fixed",
      "ready": true,
      "totalBytes": 511101161472,
      "freeBytes": 102030405060,
      "clusterBytes": 4096
    }
  ]
}
```

- `type` is one of `fixed`, `removable`, `network`, `cdrom`, `ramdisk` or `unknown`.
- A drive that isn't ready, such as an empty card reader, is listed with `ready: false`. Its `label`, `fileSystem` and the byte fields are then `""` and `0`.
- Drives come in letter order.

### `POST /v1/scans`

Request body:

```json
{ "path": "C:\\", "allocated": true }
```

- `path`: absolute. `C:` means `C:\`. Forward slashes, `\\?\` prefixes and network shares (`\\server\share`) are allowed. The helper cleans the path and upper-cases the drive letter. A root that exists but can't be read is still scanned, and gets the `unreadable` bit.
- `allocated` (default `true`): also work out the size on disk.

Response: `202 Accepted` with `{ "id": "s1" }`.

Only one scan exists at a time. Starting a new scan cancels and discards the previous one. Ids are unique within the helper's lifetime (`s1`, `s2`, …).

### `GET /v1/scans/{id}`

```json
{
  "id": "s1",
  "state": "running",
  "path": "C:\\",
  "entries": 182344,
  "files": 170001,
  "dirs": 12342,
  "bytes": 98765432100,
  "errors": 17,
  "currentPath": "C:\\Windows\\WinSxS",
  "elapsedMs": 5321,
  "error": ""
}
```

- `state` is `running`, `done`, `cancelled` or `failed`. When it is `failed`, `error` holds a message.
- `bytes` is the logical size found so far.
- `entries` counts every entry in the result, including the root.
- The website polls about every 150 ms while the scan runs.

### `GET /v1/scans/{id}/result`

`200`, `Content-Type: application/octet-stream`, in the binary format below. Available when the state is `done` or `cancelled` (then partial). While the scan runs this returns `409 scan_running`. The result can be fetched again until the next scan starts.

### `POST /v1/scans/{id}/cancel`

Returns `202` with the progress object, which already says `cancelled`. The result is frozen at that moment and can be fetched as a partial result.

### `POST /v1/reveal`

Request body: `{ "path": "C:\\Users\\Ann\\Videos\\trip.mkv" }`

Opens File Explorer with the item selected; for a folder, its parent opens with the folder selected. It uses `SHOpenFolderAndSelectItems`, so nothing is executed or opened with an app.

Returns `200` with `{}`. Errors: `400 bad_request`, `404 not_found`, and `500 internal` if the shell call fails. It accepts the same path forms as scans.

### `POST /v1/recycle`

Moves items to the Windows Recycle Bin. The website calls this only after the user has confirmed it in a dialog.

Request body:

```json
{
  "items": [
    { "path": "C:\\Users\\Ann\\Videos\\trip.mkv", "isDir": false, "size": 4509715660, "mtime": 1730000000000 }
  ],
  "dryRun": false
}
```

- `items`: 1 to 100 entries. `isDir`, `size` and `mtime` are the values from the scan result. Folders don't need `size` and `mtime`.
- Paths must be exactly in clean form: an upper-case drive letter, backslashes only, no trailing `\`, no `.` or `..` parts, no `\\?\` or `\\.\` prefix. Anything else, including a bare `C:`, is `invalid`.
- `dryRun: true` runs every check below but changes nothing. The website uses it when the dialog opens, to show warnings in advance. A missing `dryRun` counts as `false`.
- A malformed request returns `400 bad_request`: fewer than 1 or more than 100 items, `isDir` missing, a file without `size` or `mtime`, or wrong types.

The helper opens each item once, for its attributes only, using backup semantics and without following reparse points, so cloud files are never downloaded. Type, size, last write time, reparse tag and the final path all come from that one handle.

The helper checks each item in this order, and the first check that fails sets its status:

| Status | Check |
| --- | --- |
| `invalid` | the path is absolute, clean and not a device path |
| `not_found` | the item still exists |
| `changed` | it is still a folder or a file, as `isDir` says. A file must also have the same `size`, and an `mtime` within 2 seconds of the scan. Folders are not compared in depth |
| `protected` | it is not in a protected location (see below) |
| `unsupported` | all of these hold: it is on a local fixed drive (so not removable, network or SUBST), which has a Recycle Bin; its path fits the shell's limit of 259 characters; it is not itself a link; it isn't reached through a link or an 8.3 short name, so its final path equals the requested path; and Windows reads its name the same way, so the name doesn't end in a dot or space and isn't a device name such as `NUL` |

If every check passes, the item gets `ok` in a dry run. Otherwise it goes to the Recycle Bin and gets `recycled`, or `failed` with a message. After a reported success the helper checks that the item is really gone. If it isn't, the status is `failed` with "the item is still there". `failed` can also come from a dry run, for an item that can't even be opened for its attributes: "could not check the item".

Messages are in English.

Response: `200` with one result per item, in the same order:

```json
{ "results": [ { "path": "C:\\Users\\Ann\\Videos\\trip.mkv", "status": "recycled", "message": "" } ] }
```

**Protected locations** can never be recycled, as administrator neither:

- every drive root, and `$Recycle.Bin` and `System Volume Information` with everything inside;
- `pagefile.sys`, `hiberfil.sys`, `swapfile.sys` and `DumpStack.log.tmp` in a drive root;
- `%SystemRoot%` (`C:\Windows`), `%ProgramFiles%` and `%ProgramFiles(x86)%`, each with everything inside;
- these folders themselves, while their contents are allowed: `%ProgramData%`, the users folder (`C:\Users`), every user profile folder, and each profile's `AppData`, `AppData\Local`, `AppData\Roaming`, `Desktop`, `Documents`, `Downloads`, `Pictures`, `Music` and `Videos`;
- the current user's real Desktop, Documents, Downloads, Pictures, Music, Videos and AppData folders themselves, also when they are redirected elsewhere;
- the helper's own exe, its folder, and every folder above it up to the drive root.

Every entry in the users folder counts as a profile, including links such as `All Users`. Protection is checked against both the requested path and the final path, ignoring case the way NTFS does.

On systems other than Windows, `features` is `["scan"]` and both endpoints are unknown (`404`).

**Never permanently:** the helper uses `SHFileOperationW` with `FO_DELETE` and `FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI | FOF_WANTNUKEWARNING`.

- `FOF_ALLOWUNDO` sends items to the Recycle Bin.
- If Windows would have to delete an item permanently anyway, for example because it is too big for the Recycle Bin, `FOF_WANTNUKEWARNING` makes Windows ask the user first. If the user says no, nothing happens and the status is `failed`, with a message saying so.
- Items are handled one at a time, so a failure doesn't affect the others.

### `POST /v1/elevate`

Restarts the helper with administrator rights, so folders such as other users' profiles can be read.

- Already elevated: `200` with `{ "elevated": true }`.
- Otherwise the helper starts itself again with the `runas` verb, which shows the Windows UAC prompt.
  - **Accepted:** `202` with `{ "restarting": true }`. The helper closes its listener right after sending the response and exits. The elevated instance is started with `--serve --takeover --port <p>`, plus `--dev` and `--origin` when they were set, and binds the same port, retrying for up to 15 seconds. The website polls `/v1/info` until `elevated` is `true`.
  - **Once elevated**, the helper turns on SeBackupPrivilege, for reading only. This lets the listing reach folders whose permissions deny even administrators. Mapped network drives may be missing in the elevated instance, because Windows runs it in a separate logon session.
  - **Declined:** `200` with `{ "elevated": false, "cancelled": true }`. The helper keeps running.

### `POST /v1/shutdown`

`202` with `{}`, then the helper exits.

### `POST /v1/uninstall`

Removes the `diskatlas-helper://` link registration. Returns `200` with `{}`, then the helper exits.

## Binary result format

Little-endian. Every section begins at an offset that is a multiple of 8, with zero bytes as padding, so the website can lay typed arrays directly over the buffer.

| Offset | Type | Content |
| --- | --- | --- |
| 0 | 4 bytes | magic `DAH1` (ASCII) |
| 4 | u32 | format version, `1` |
| 8 | u32 | `count`: number of entries, root included |
| 12 | u32 | flags: bit 0 = `allocated` section present |
| 16 | u32 | `namesLength`: byte length of the names section |
| 20 | u32 | reserved, `0` |
| 24 | bytes | **names**: UTF-8, the `count` names joined with `\0`, with no trailing `\0` |
| pad 8 | i32 × count | **parent**: index of the parent entry; `-1` for the root |
| pad 8 | u8 × count | **kind**: bit flags, see below |
| pad 8 | f64 × count | **size**: logical size in bytes; `0` for folders |
| pad 8 | f64 × count | **mtime**: last write time, in milliseconds since 1970-01-01 UTC; `0` if unknown |
| pad 8 | f64 × count | **allocated** (only if flag bit 0): size on disk in bytes; `0` for folders |

"pad 8" means: zero bytes up to the next multiple of 8. A section that already starts on one gets no padding.

Rules:

- Index `0` is the root. `parent[i] < i` for every `i > 0`, so a parent always comes before its children. Entries are not sorted; the website aggregates and sorts them.
- **The root's name** is the scanned path without a trailing separator: `C:` for a drive root, `C:\Users\Ann` for a folder. Every other name is a single path component.
- Folder sizes are `0` in the result. The website adds them up.

`kind` bits:

| Bit | Value | Meaning |
| --- | --- | --- |
| 0 | 1 | folder |
| 1 | 2 | unreadable: the folder could not be listed (for example access denied), or the file's details could not be read |
| 2 | 4 | link: a symbolic link, junction or mount point. It is listed but not followed; its size is `0` |
| 3 | 8 | cloud: an online-only placeholder, such as OneDrive Files On-Demand. Its logical size is real, but its size on disk is `0`. The helper never opens it, so nothing gets downloaded |

## How the helper scans (Windows)

- It lists folders with `FindFirstFileExW` / `FindNextFileW` (`FindExInfoBasic`, `FIND_FIRST_EX_LARGE_FETCH`) on `\\?\` paths, so long paths work. Size, attributes, last write time and the reparse tag all come from the listing, and no file is opened.
- It reads several folders in parallel.
- Reparse points:
  - Name surrogates (symbolic links, junctions, mount points; tag bit `0x20000000`) are recorded with the `link` bit and not followed.
  - Other reparse points, such as cloud files and folders, are handled like normal entries.
- Size on disk:
  - Cloud placeholders (`FILE_ATTRIBUTE_OFFLINE`, `RECALL_ON_OPEN` or `RECALL_ON_DATA_ACCESS`): `0`, with the `cloud` bit.
  - Compressed or sparse files, including files compressed by Windows (CompactOS, reparse tag `0x80000017`): `GetCompressedFileSizeW`. If that fails, the size is rounded up as below, and the file gets the `unreadable` bit.
  - Everything else: the logical size rounded up to the volume's cluster size.
- Hard links are counted once per link, as Windows Explorer does.
- A folder that can't be listed gets the `unreadable` bit and counts as an error, and the scan goes on.

## Starting and stopping

- **First run** (double-click, no arguments): the helper registers the `diskatlas-helper://` link for the current user (`HKCU\Software\Classes`, no admin needed), starts listening, and opens the website. It keeps running without a window.
- **Started from the website**: the site navigates to `diskatlas-helper://start`. The browser asks whether to open the DiskAtlas Helper, and Windows then starts it with that URL as its only argument. It refreshes the registration and starts listening, but doesn't open the website.
- **Already running**: a new instance checks whether the port belongs to a running helper (`GET /v1/info`). If it does, the new instance exits, after opening the website if it was started by a double-click.
- **Auto-exit**: after 10 minutes without a request while no scan is running.
- **Log**: `%LOCALAPPDATA%\DiskAtlas\helper.log`, cut back when it exceeds 1 MB. It never contains scanned file names, only the start, stop, errors and the scanned root paths.

Command-line options:

- `--dev`
- `--origin <origin>`, repeatable
- `--port <n>`: only this port
- `--idle <duration>`: a Go duration or plain seconds; `0` turns the idle exit off
- `--serve`: listen only, with no registration and no website
- `--no-open`
- `--uninstall`
- `--version`
- `--takeover`: internal, used by `/v1/elevate`

The link registration keeps `--dev` and `--origin`, so a helper registered from a development run keeps accepting the development site.

## Build

```bash
cd helper
go build -trimpath -ldflags "-H=windowsgui -s -w -X main.version=0.1.0" -o bin/DiskAtlas-Helper.exe .
```

These build-time variables can be changed with `-X`:

- `main.version`
- `main.siteURL`: default `https://lunixxx37.github.io/diskatlas/`
- `main.siteOrigin`: default `https://lunixxx37.github.io`
