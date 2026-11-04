# Launch checklist

The source code is public on GitHub. The website isn't online yet; it goes live once you host it, with an imprint. These are the remaining steps.

## 1. Helper release

- [x] Icon and Windows version information for `DiskAtlas-Helper.exe`, added by go-winres in GitHub builds.
- [x] Release workflow: on a `v*` tag, build the exe and attach it to a GitHub Release. The website's download button points to `https://github.com/lunixxx37/diskatlas/releases/latest/download/DiskAtlas-Helper.exe`. The test pre-release `v0.1.0-rc.1` worked; delete it whenever you like.
- [ ] Code signing: apply at [signpath.org/apply](https://signpath.org/apply.html). This is possible now that the repository is public. Until the helper is signed, Windows SmartScreen warns on download and UAC shows "unknown publisher".
  - SignPath Foundation's [terms](https://signpath.org/terms) require an open-source project without proprietary parts, built only from your own sources, and multi-factor authentication on GitHub and SignPath for everyone on the team.
  - The certificate is issued to SignPath Foundation, so Windows names it as the publisher, not you.
  - Signing then runs as a step in `.github/workflows/release.yml`, where a comment marks the spot. It needs an API token as a repository secret and the organization ID.
- [ ] Release `v0.1.0`: push the tag, and the workflow builds and publishes it. Until then the download button finds no release, because pre-releases don't count as "latest".
- [ ] On the development PC, remove the test link registration, which points at the development build with `--dev`. Run this in your own terminal, not from a sandboxed tool:

  ```bash
  helper/bin/DiskAtlas-Helper.exe --uninstall
  ```

## 2. Repository

- [x] The repository is public (MIT). A public open-source repository on GitHub needs no imprint of its own; GitHub is the provider there.

## 3. Website, when you host it

Whoever runs the publicly reachable website needs an imprint and a privacy policy on it. That applies with GitHub Pages too, and it is not legal advice.

- [ ] Imprint (Impressum) with name, postal address and email, in German and English, plus a privacy policy (Datenschutzerklärung). The privacy policy says that DiskAtlas processes nothing on a server and names what the host logs, for example visitors' IP addresses.
- [ ] Keep the personal details out of the repository. Store them as repository secrets, and let the build insert them into the imprint page, so they appear only on the website and never in the code or its history.
- [ ] Link both pages from the footer of every view.
- [ ] Hosting:
  - **GitHub Pages:** turn it on with "GitHub Actions" as the source (`gh api -X POST repos/lunixxx37/diskatlas/pages -f build_type=workflow`). Then add `push: branches: [main]` to `.github/workflows/pages.yml` and run it once.
  - **Your own server or domain:** build with `npm run build` and upload `dist/`. The helper only answers the origin it was built for. Build releases with `-X main.siteURL=https://your-domain/ -X main.siteOrigin=https://your-domain`, or add that origin to the defaults in `helper/main.go`.

## 4. Check the live site

- [ ] The site loads with no console errors and no CSP violations, and the fonts come from the site itself.
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
