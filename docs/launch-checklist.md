# Launch checklist

DiskAtlas stays private while it is in development. These steps take it public.

## 1. Legal pages

- [ ] Imprint (Impressum) with name, postal address and email, in German and English.
- [ ] Privacy policy (Datenschutzerklärung) in German and English. It says that DiskAtlas processes nothing on a server, and that GitHub Pages, the host, logs visitors' IP addresses.
- [ ] Link both from the footer of every view.

## 2. Helper release

- [x] Icon and Windows version information for `DiskAtlas-Helper.exe`, added by go-winres in GitHub builds.
- [x] Release workflow: on a `v*` tag, build the exe and attach it to a GitHub Release. The website's download button points to `https://github.com/lunixxx37/diskatlas/releases/latest/download/DiskAtlas-Helper.exe`. The test pre-release `v0.1.0-rc.1` worked; delete it before the launch if you like.
- [ ] Code signing: apply at [signpath.org/apply](https://signpath.org/apply.html) once the repository is public. Until the helper is signed, Windows SmartScreen warns on download and UAC shows "unknown publisher".
  - SignPath Foundation's [terms](https://signpath.org/terms) require an open-source project without proprietary parts, built only from your own sources, and multi-factor authentication on GitHub and SignPath for everyone on the team.
  - The certificate is issued to SignPath Foundation, so Windows names it as the publisher, not you.
  - Signing then runs as a step in `.github/workflows/release.yml`, where a comment marks the spot. It needs an API token as a repository secret and the organization ID.
- [ ] Release `v0.1.0`: push the tag, and the workflow builds and publishes it.
- [ ] On the development PC, remove the test link registration, which points at the development build with `--dev`. Run this in your own terminal, not from a sandboxed tool:

  ```bash
  helper/bin/DiskAtlas-Helper.exe --uninstall
  ```

## 3. Repository and website

- [ ] Make the repository public:

  ```bash
  gh repo edit lunixxx37/diskatlas --visibility public --accept-visibility-change-consequences
  ```

- [ ] Turn on GitHub Pages with "GitHub Actions" as the source:

  ```bash
  gh api -X POST repos/lunixxx37/diskatlas/pages -f build_type=workflow
  ```

- [ ] Add `push: branches: [main]` to `.github/workflows/pages.yml`, then run it once.

## 4. Check the live site

- [ ] https://lunixxx37.github.io/diskatlas/ loads with no console errors and no CSP violations, and the fonts come from the site itself.
- [ ] The demo, the folder picker and drag and drop work in Chrome and Edge, and the limited mode works in Firefox.
- [ ] Connecting to the helper from the HTTPS origin: Chrome shows its "loopback network" permission prompt once. After that, scan, Explorer and Recycle Bin all work.
- [ ] The language switch and the light and dark themes work.
- [ ] A last design review of everything added since the first one: the helper section, the language switch, the duplicates tab and the dialogs.

## Testing note

Test the `diskatlas-helper://` link with a helper that you started yourself, by double-click or from your own terminal. Tools that run commands in a sandbox can write the registry into a private layer that browsers don't see. Chrome then reports "the scheme does not have a registered handler" and asks nothing, even though the registration looks fine from inside the sandbox.

## Later

- Count hard links only once (helper), so system drives add up to the space really used.
- Give recycle and delete results a stable error code (for example `access_denied`, `in_use`), so the website doesn't have to recognise Windows' English message text. Windows without English message resources may answer in its own language.
- Search and filter; compare with the last scan.
