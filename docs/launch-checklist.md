# Launch checklist

The source code is public on GitHub. The website isn't online yet; it goes live once you host it, with an imprint. These are the remaining steps.

## 1. Helper release

- [x] Icon and Windows version information for `DiskAtlas-Helper.exe`, added by go-winres in GitHub builds.
- [x] Release workflow: on a `v*` tag, build the exe and attach it to a GitHub Release. The website's download button points to `https://github.com/lunixxx37/diskatlas/releases/latest/download/DiskAtlas-Helper.exe`. The test pre-release `v0.1.0-rc.1` worked; delete it whenever you like.
- [ ] Code signing. Until the helper is signed, Windows SmartScreen warns on download and UAC shows "unknown publisher". On PCs with Smart App Control turned on, Windows blocks unsigned programs that it doesn't know yet, with no way to run them anyway. The options as of November 2026:
  - **Microsoft Store (recommended next).** Registration is free for individual developers, and the Store signs MSIX packages itself. Apps installed from the Store get no SmartScreen warning, and installing registers the `diskatlas-helper://` link straight away. It needs an MSIX package of the helper that declares the link in its manifest instead of writing it to the registry (registry writes from inside a package are virtualized, much like in the sandbox described under "Testing note"), a check that restarting as administrator still works there (the `allowElevation` capability), a Partner Center account that you create yourself, and a Store listing with description, screenshots and privacy policy. Keep the unsigned exe on GitHub for PCs without the Store.
  - **Certum Open Source Code Signing**, the cheapest certificate for an individual: in Certum's shop from €49 with signing in the cloud (SimplySign), or €69 with card and reader. Certificates now last at most 459 days, so the cost recurs. It is issued in your own name ("Open Source Developer, …") after an identity check and a proof of address, for a public project that isn't sold. Signed programs pass Smart App Control and UAC names you as the publisher, but SmartScreen still warns until the certificate has built up reputation. Signing needs a login with a code from the SimplySign phone app, so it happens on your PC, not in GitHub Actions.
  - **SignPath Foundation** declined the application on 4 November 2026. Its free program is for projects that are already publicly known: stars, forks and contributors on GitHub, articles, or discussions on Reddit, Stack Overflow or YouTube. Reapply at [signpath.org/apply](https://signpath.org/apply.html) once DiskAtlas has those, and put its attribution text back into the README and the release notes.
  - Not suitable: SignPath's paid plans (from $500 a year, with a certificate for registered organizations only), Azure Artifact Signing (individual developers only in the USA and Canada) and EV certificates (expensive, and since 2024 they no longer speed up SmartScreen reputation).
  - Signing in GitHub Actions would be a step in `.github/workflows/release.yml`, where a comment marks the spot.
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
