# vscode-prism — Inventory & Maturity Audit
_Generated 2026-05-25 · Sibling to prism0x2A dashboard · Ship-decision document_

## 1. TL;DR — Maturity Verdict

- **Scope is small and tractable.** Entire extension is **one 508-line TypeScript file** (`src/extension.ts`) + a generated 8.4 KB bundle (`dist/extension.js`). No view providers, no webviews, no language servers — just a status bar, CodeLens, diagnostics, and 6 commands.
- **Most features are wired end-to-end** against local `.amber/` / `.prism/` JSON files. The status bar, CodeLens, drift diagnostics, "tag file", "show capabilities", "open dashboard", and "show coherence score" all run real code paths.
- **`prism.healDrift` is the only feature with a hard external dependency** — it POSTs to `http://localhost:3000/api/amber/ai/heal-drift` (the prism0x2A dashboard) and will silently no-op if the dashboard is not running.
- **Zero tests.** No `test/`, no `*.test.ts`, no test framework in `devDependencies`, no `vscode-test` runner. The user's claim of "untested" is fully confirmed.
- **One declared dependency (`prismlens: latest`) is imported nowhere** in source or build output — dead weight that needs to be removed before publish (also the `"latest"` range is a marketplace anti-pattern).
- **Ship-readiness:** **FIX-FIRST.** It is closer to publish than expected (icon, LICENSE, marketplace metadata, CI/release workflow all present), but ~6 small blockers (publisher account, unused dep, broken type cast at line 142, missing `CHANGELOG.md`, missing screenshots that the README references, no smoke test) keep it from being a clean v0.1.0 publish.

## 2. Manifest (package.json)

| Field | Value | Notes |
|---|---|---|
| `name` | `vscode-prism` | OK |
| `displayName` | `PRISM — Architecture Intelligence` | OK |
| `publisher` | `prism0x2a` | **Publisher account must exist on Marketplace + Open VSX before publish — verify.** |
| `version` | `0.1.0` | Initial release |
| `engines.vscode` | `^1.85.0` | Nov 2023, fine baseline |
| `main` | `./dist/extension.js` | Matches built artifact |
| `icon` | `media/icon.png` | Present (689 B — very small; check pixel size) |
| `repository.url` | `https://github.com/prism0x2A/vscode-prism` | **Verify repo exists / is public** |
| `categories` | `["Linters", "Other"]` | OK |
| `keywords` | `architecture, amber, code-quality, prism, drift, capabilities` | OK |
| `activationEvents` | `workspaceContains:.amber/capabilities.md`, `workspaceContains:.prism/config.json` | Good — lazy activation, no startup cost |
| `bugs` / `homepage` | **MISSING** | Recommended marketplace metadata |
| `license` field | **MISSING** (LICENSE file exists) | Add `"license": "MIT"` to package.json |

## 3. Source Tree

```
vscode-prism/
├── .github/workflows/
│   ├── ci.yml          # build + typecheck + package on push/PR
│   └── release.yml     # tag-triggered: package, publish to VSCE + Open VSX, GH release
├── dist/
│   └── extension.js    # 8,374 B — minified esbuild bundle (newer than src/, in sync)
├── media/
│   └── icon.png        # 689 B — extension icon
├── src/
│   └── extension.ts    # 508 lines — entire extension
├── LICENSE             # MIT, © 2025 prism0x2A
├── README.md           # 3 KB — features, setup, config table
├── package.json        # manifest + scripts
├── package-lock.json   # 121 KB
├── tsconfig.json       # ES2022 / commonjs / strict / outDir dist
├── .vscodeignore       # excludes src/, *.ts, *.map; keeps dist/, media/
├── .gitignore          # node_modules, dist, *.vsix, out
└── vscode-prism-0.1.0.vsix  # 9,095 B — built artifact, 7 files
```

### Per-file purpose

| File | Purpose |
|---|---|
| `src/extension.ts` | The entire extension. Activation, data loading, status bar, CodeLens provider, diagnostics, 6 command handlers, file watcher, deactivation. |
| `dist/extension.js` | esbuild minified CJS bundle. Built `May 23 16:35`; source last edited `May 23 16:19` → **dist is in sync with src**. |
| `media/icon.png` | Marketplace icon. |

## 4. Activation & Contribution Surface

### 4.1 Commands

All 6 commands declared in `package.json:33-59` and registered in `extension.ts:465-475`.

| ID | Title | Handler (file:line) | Status |
|---|---|---|---|
| `prism.openDashboard` | Open Dashboard | `extension.ts:317-319` (`openDashboard`) | **Live** — opens `dashboardUrl()` via `env.openExternal` |
| `prism.runScan` | Run AMBER Scan | `extension.ts:471-474` (inline arrow) | **Stub** — opens `<dashboardUrl>/amber` and shows an info message. Does not actually run a scan from the editor. |
| `prism.tagFile` | Tag This File with Capability | `extension.ts:235-278` (`tagCurrentFile`) | **Live** — QuickPick over registry, inserts JSDoc with `@amber-capability` at line 0, saves. |
| `prism.showCapabilities` | Show All Capabilities | `extension.ts:323-352` (`showCapabilities`) | **Live** — QuickPick browser → opens dashboard capability page. |
| `prism.showCoherenceScore` | Show Coherence Score | `extension.ts:282-313` (`showCoherenceScore`) | **Live** — info message with score + grade + actions. |
| `prism.healDrift` | Auto-heal Drift in This File | `extension.ts:356-415` (`healDrift`) | **Partial** — requires prism0x2A dashboard running locally; uses `fetch` to POST to `/api/amber/ai/heal-drift`. Hard-coded to expect a `{action, reasoning, newDoc}` JSON shape. Catches network errors with a user-friendly message. |

### 4.2 Views / Panels

**None.** No `contributes.views`, no `contributes.viewsContainers`, no webview panels. All UI is via VS Code's built-in primitives (status bar, info messages, QuickPick, CodeLens, diagnostics).

### 4.3 Decorations / Hovers / Code Actions

| Surface | Present? | Evidence |
|---|---|---|
| Status bar | YES | `extension.ts:51,441,118-150` — `$(shield) <score> <grade>` with color-coded background, click → `prism.showCoherenceScore` |
| CodeLens | YES | `PrismCodeLensProvider` `extension.ts:195-231`, registered at `:450-455` for `**/*.{ts,tsx,js,jsx,py,go,rs,java,cs}`; renders `🟡 AMBER: <name> (<id>)[ ⚠ drift]` on line 0 |
| Diagnostics | YES | `updateDiagnostics` `extension.ts:154-191` — single `Warning` on line 0 of any drifted file, `source: "PRISM AMBER"`, `code: "amber-drift"` |
| **Hover provider** | **NO** | README does not actually claim hover. The task brief mentioned "hover for coherence score" as a marketing claim — **not implemented**. No `registerHoverProvider` anywhere. |
| **Code action (quick-fix) provider** | **NO** | No `registerCodeActionsProvider`. Heal-drift is a command, not a quick-fix lightbulb. The task brief's "quick-fix suggestions" claim is **not implemented as code actions** — only as a context-menu command. |
| Decorations (TextEditorDecorationType) | NO | None registered. "Inline drift annotations" surface as diagnostic squiggles only. |

### 4.4 Settings

`package.json:60-89`. All 5 read in extension via `config(key, default)` helper at `extension.ts:74-76`.

| Setting | Type | Default | Read at |
|---|---|---|---|
| `prism.dashboardUrl` | string | `http://localhost:3000` | `:79` |
| `prism.showStatusBar` | boolean | `true` | `:119` |
| `prism.showDriftDiagnostics` | boolean | `true` | `:155` |
| `prism.showCapabilityLens` | boolean | `true` | `:204` |
| `prism.autoRefresh` | boolean | `true` | **DECLARED BUT NEVER READ.** Grep confirms no reference in `extension.ts`. The watcher (`setupWatcher` `:419-433`) always runs unconditionally. |

### 4.5 Status Bar / Menus / Keybindings

- **Status bar:** described above.
- **Menus:** `package.json:90-102` adds `prism.tagFile` (when `resourceExtname` matches `.ts/.tsx/.js/.jsx/.py/.go/.rs`) and `prism.healDrift` (unconditional) to `editor/context`.
- **Keybindings:** **None contributed.**

## 5. Data Flow — How it talks to prism0x2A

**Read path (no server required):** direct filesystem reads via `node:fs.readFileSync` (`extension.ts:66-72`).

```
workspaceRoot/
├── .amber/
│   ├── capabilities.md          ← activation trigger (not parsed)
│   ├── state.json               ← read at :85 → AmberState (files → {capabilities, doc_hash, drift})
│   ├── registry.json            ← fallback read at :89
│   └── scan.json                ← read at :107 → {drift: DriftEntry[]}
└── .prism/
    ├── config.json              ← activation trigger (not parsed)
    ├── amber-registry.json      ← primary read at :87 → Registry[]
    └── green/
        └── coherence-history.json  ← read at :91 → CoherenceHistory
```

**Write path:**
- `tagCurrentFile` (`:272-275`) — inserts JSDoc into the active editor's file via `WorkspaceEdit` + `document.save()`.
- `healDrift` (`:395-401`) — regex-replaces `@amber-doc <text>` in the active file.

**Network calls:**
- `prism.healDrift` → `POST {dashboardUrl}/api/amber/ai/heal-drift?target={root}` (`:370-378`) using global `fetch` (requires Node 18+ — fine for VS Code 1.85+).
- All other "open dashboard" actions → `vscode.env.openExternal(<url>)` (browser, not a network call from the extension).

**LLM calls:** None directly. The dashboard's `/api/amber/ai/heal-drift` endpoint is presumably LLM-backed, but the extension is a thin POST client.

**Telemetry:** None. README ("Zero telemetry") is accurate — no analytics SDK, no `reporter`, no outbound calls beyond the explicit heal-drift POST.

## 6. Build & Packaging

| Aspect | Detail |
|---|---|
| Build tool | `esbuild` 0.20 — single bundle, minified, CJS, external `vscode` |
| Build cmd | `npm run build` → `esbuild src/extension.ts --bundle --outfile=dist/extension.js --external:vscode --format=cjs --platform=node --minify` |
| Watch | `npm run dev` (sourcemap + watch) |
| Typecheck | `npm run typecheck` (`tsc --noEmit`, ES2022/commonjs/strict) |
| Lint | `npm run lint` (eslint) — **but eslint not in devDependencies** → command will fail |
| Package | `npm run package` (`vsce package`) |
| `dist/` freshness | dist mtime `2026-05-23 16:35:59` > src mtime `2026-05-23 16:19:46` → **in sync** |
| `.vsix` contents | 7 files, 19,996 B total: `extension.vsixmanifest`, `[Content_Types].xml`, `extension/dist/extension.js` (8,374 B), `extension/LICENSE.txt`, `extension/media/icon.png`, `extension/package.json`, `extension/README.md` |
| `.vscodeignore` | Properly excludes `src/`, `*.ts`, `*.map`, `tsconfig.json`, `node_modules/`. **Does NOT exclude `.github/`** — minor noise but vsce excludes it by default. |

`.vsix` was built **May 23 2026** at the same time as the dist bundle. No drift between the committed `.vsix` and the current source.

## 7. Testing

**Evidence:**

| Check | Result |
|---|---|
| `find . -name "*.test.ts" -not -path "./node_modules/*"` | **0 matches** |
| `find . -name "*.spec.ts" -not -path "./node_modules/*"` | **0 matches** |
| `test/` directory | **does not exist** |
| Test framework in `devDependencies` | **none** (no mocha, jest, vitest, `@vscode/test-electron`, `@vscode/test-cli`) |
| `npm test` script | **not defined** |
| CI test step | `ci.yml` runs `typecheck` + `build` + `package` only — **no test step** |

**Verdict: completely untested.** Confirms the user's description. There is not even a smoke-test that loads the extension in a headless VS Code.

## 8. Dependencies — Risk Read

### Production dependencies (`package.json:112-114`)

| Package | Version | Risk |
|---|---|---|
| `prismlens` | `latest` | **HIGH** for ship: (a) **never imported** anywhere in `src/` or `dist/` — grep confirms 0 references → dead weight in the dependency graph (but not in the bundle, since esbuild tree-shakes — verify by checking bundle size); (b) `"latest"` range is a **marketplace anti-pattern** — every install gets a different version; (c) the package itself is `"private": false` but `license: UNLICENSED` per `node_modules/prismlens/package.json` → publishing an extension that depends on an unlicensed package is a legal smell. **Remove this dep before publish unless it's actually wired in.** |

Note: because the build uses esbuild with no `--external` other than `vscode`, the bundle inlines everything it imports. Since nothing imports `prismlens`, the bundle is clean — but the package.json still declares the dep, which is what marketplace consumers see.

### Dev dependencies

| Package | Version | Risk |
|---|---|---|
| `@types/node` | `^20.0.0` | Fine |
| `@types/vscode` | `^1.85.0` | Matches engine |
| `@vscode/vsce` | `^2.24.0` | Current major; `v3` released — non-blocking |
| `esbuild` | `^0.20.0` | Mature, fine |
| `typescript` | `^5.4.0` | Fine |
| eslint | **missing** | `lint` script in `package.json:109` references eslint but eslint is not installed → `npm run lint` will throw "command not found" |

## 9. Feature Maturity Matrix

| Feature | Status | Evidence (file:line) | Ship-now risk | Hardening effort |
|---|---|---|---|---|
| Status-bar coherence score | **Live** | `extension.ts:118-150`, registered `:441` | Low — falls back to `$(shield) PRISM` when no history (`:127-131`). **Bug:** type-narrowing on line 142–143 is broken (see §10). | 30 min — fix the type narrowing |
| CodeLens capability tags | **Live** | `extension.ts:195-231`, registered `:450-455` | Low | Negligible |
| Drift diagnostics (squiggle) | **Live** | `extension.ts:154-191` | Low — only attaches to drifted files; clears properly | Negligible |
| `prism.openDashboard` | **Live** | `extension.ts:317-319` | Low | None |
| `prism.runScan` | **Stub** (opens browser tab; does not run a scan) | `extension.ts:471-474` | Low (user-visible expectation mismatch only) | 1–2 days — would need a CLI subprocess or dashboard API |
| `prism.tagFile` | **Live** | `extension.ts:235-278` | Low — guards on no editor / no registry / existing tag | Negligible |
| `prism.showCapabilities` | **Live** | `extension.ts:323-352` | Low | Negligible |
| `prism.showCoherenceScore` | **Live** | `extension.ts:282-313` | Low | Same broken cast at `:298-300` as §10 |
| `prism.healDrift` | **Partial** | `extension.ts:356-415` | **Medium** — requires dashboard running locally; entire feature is silent if not. Regex `:393` only fires if file already has `@amber-doc`; no path for files missing the tag. | 1 day — improve fallback + add CodeAction quick-fix surface |
| Auto-refresh watcher | **Live** | `extension.ts:419-433`, called `:461` | Low — properly disposed in `deactivate()` (`:504`) | None |
| `prism.autoRefresh` setting | **Dead** — declared but never honored | `package.json:83-87` vs no read in `extension.ts` | Low (cosmetic) | 15 min — wire it into `setupWatcher` |
| Hover provider for coherence | **Missing** | n/a — no `registerHoverProvider` | n/a | 2–3 days |
| Quick-fix code action for drift | **Missing** | n/a — no `registerCodeActionsProvider` | n/a (heal-drift is exposed as a command instead) | 1–2 days |
| Tree view / sidebar | **Missing** | n/a — no `contributes.views` | n/a | 3–5 days |

**Tally:** 8 live, 1 partial, 1 stub, 1 dead setting, 3 marketing-implied-but-absent surfaces.

## 10. Bugs & Risk Areas Spotted

### B1 — Broken type narrowing on `history.latest` vs `history.entries[last]` (HIGH-impact, easy fix)
**Location:** `extension.ts:124`, `:142-143`, `:284`, `:298-300`.

```ts
// :124
const latest = history?.latest ?? history?.entries[history.entries.length - 1] ?? null;
```

`history.latest` has type `{ score, grade, label } | null`; `entries[i]` has type `{ score, grade, computedAt }` (no `label`). The subsequent code at `:142-143` does:

```ts
const scoreLabel = typeof latest === "object" && "score" in latest ? latest.score : (latest as {score:number}).score;
const gradeLabel = typeof latest === "object" && "grade" in latest ? (latest as {grade: string}).grade : "?";
```

This is nonsense — the ternary's "else" branch is unreachable (if `latest` is non-null and an object, both branches return the same thing), and the cast to `{grade:string}` always succeeds at runtime even when grade is `undefined`. The code happens to work because both shapes share `score` and `grade`, but **the `tooltip` and status text will render `undefined` if `entries` is empty and `latest` is the wrong shape**. Same pattern repeats at `:298-300`.

### B2 — `prismlens` is a declared dependency that is never used (MEDIUM)
See §8. Either remove it or actually use it. `"latest"` version range is a publish-time anti-pattern regardless.

### B3 — `prism.autoRefresh` setting is wired in package.json but never read (LOW)
The watcher always runs. Either remove the setting or honor it in `setupWatcher` (`extension.ts:419`).

### B4 — README references screenshots that don't exist (LOW, user-visible on Marketplace)
`README.md` line ~12: `![Status Bar](media/statusbar.png)`. The `media/` directory contains only `icon.png`. The image will render as a broken link on the VS Code Marketplace listing.

### B5 — `npm run lint` will fail (LOW)
`package.json:109` declares an eslint script but eslint is not in `devDependencies`. Not blocking (no CI runs it), but the script is a lie.

### B6 — `healDrift` silently no-ops if `@amber-doc` tag is missing (LOW)
`extension.ts:393-403`: if the file has drift but no `@amber-doc` regex match, the API still succeeds, but the editor receives no edit and no message. Add a fallback `showInformationMessage`.

### B7 — Status-bar background color undefined for grade `F` colors / not all grades covered (LOW)
`extension.ts:134-140`: map covers `A`, `B`, `C`, `D`, `F`. If a future grade (e.g. `F+`) is computed by the dashboard, the background falls back to undefined silently. Acceptable.

### B8 — No cancellation token in CodeLens provider (LOW)
`provideCodeLenses` does synchronous filesystem-derived lookups so this is fine today, but if `loadData` ever becomes async it will leak.

### B9 — Watcher fires on every change under `.amber/**` AND `.prism/**` and unconditionally reloads everything (LOW perf)
Fine for the file sizes involved (a few KB), but a busy auto-scanner could thrash. Debounce if it becomes an issue.

### Crash / secret-leak / startup-block scan

- **Crash risk:** `safeReadJson` (`:66-72`) swallows all read/parse errors → unlikely to crash the host. The most likely crash is in CodeLens if `document.lineAt(0)` is called on an empty document — VS Code returns a 0-length line, which is safe.
- **Secret leak:** none. No env-var reads, no telemetry, no analytics SDK. The only outbound network is the explicit heal-drift POST to a user-configured URL (defaults to localhost).
- **Startup block:** activation is gated on `workspaceContains` triggers (`package.json:27-30`) and `activate()` does only synchronous JSON reads (small files) → near-zero startup cost.

## 11. Publish-Readiness Checklist

| Item | Status | Notes |
|---|---|---|
| Publisher account configured | **VERIFY** | `publisher: "prism0x2a"` — must exist on Marketplace + Open VSX. Not verifiable from repo alone. |
| Icon | YES | `media/icon.png` (689 B — confirm pixel dimensions ≥128×128) |
| Screenshots referenced in README | **NO** | `media/statusbar.png` is missing → broken image on Marketplace |
| `categories` | YES | `["Linters", "Other"]` |
| `keywords` | YES | 6 entries |
| `repository` | YES | github.com/prism0x2A/vscode-prism — **verify repo exists/public** |
| `bugs` | **NO** | Add `"bugs": { "url": "..." }` |
| `homepage` | **NO** | Add `"homepage": "https://prism0x2a.dev"` |
| `license` field in package.json | **NO** | LICENSE file exists (MIT) — add `"license": "MIT"` |
| `.vscodeignore` | YES | Sensible (excludes src, ts, maps) |
| `LICENSE` file | YES | MIT, © 2025 prism0x2A |
| `CHANGELOG.md` | **NO** | Marketplace strongly recommends one |
| `README.md` | YES | Polished, but contains broken image link |
| Marketplace verification (publisher PAT / Azure DevOps) | **VERIFY OUT-OF-BAND** | `VSCE_PAT` + `OVSX_PAT` referenced in `release.yml` but secrets must be set in GitHub Actions |
| `engines.vscode` realistic | YES | `^1.85.0` |
| CI passes | UNKNOWN | `ci.yml` runs typecheck + build + package — but no runs in this checkout |
| At least one smoke test | **NO** | Zero tests |
| `prismlens: latest` dep cleaned up | **NO** | Remove or wire in |

## 12. Recommendation

**Ship decision: FIX-FIRST, then publish.** Do **not** rebuild — the code is small, clean, and structurally sound. Do **not** publish today — there are 6 small but visible blockers that will tank the Marketplace listing.

### Pre-publish blocker list (estimated total: 1 focused day)

1. **Remove (or wire in) the `prismlens: latest` dependency.** It is currently dead weight with an unbounded version range.
2. **Add the missing screenshot** (`media/statusbar.png`) referenced by README — or remove the image line.
3. **Add `CHANGELOG.md`**, `bugs`, `homepage`, `license` fields, and a real Marketplace publisher verification step.
4. **Fix the broken type narrowing** at `extension.ts:142-143` and `:298-300` (B1) — small, but the kind of `undefined` bug that gets screenshotted in a bad review.
5. **Honor the `prism.autoRefresh` setting** (or delete it) — shipping a documented setting that does nothing is a trust hit.
6. **Add at least one smoke test** using `@vscode/test-electron` — even just "extension activates without throwing." Required to credibly claim quality.

### Post-publish roadmap (in priority order)

1. **Code action provider for drift** — turn the existing `prism.healDrift` command into a yellow lightbulb on the diagnostic. This is the single highest-ROI UX improvement and matches dashboard marketing.
2. **Hover provider** for `@amber-capability` tags showing capability name + description + score (would close the marketing gap).
3. **Real `prism.runScan`** — spawn the prism0x2A CLI as a child process, or call a dashboard API, instead of just opening the browser.
4. **Sidebar tree view** for capabilities + drifted files (justifies the `views` contribution category).

**Bottom line:** This is not a "ship later after validation" project — it is a **"ship next week after 6 hours of polish"** project. The bones are good. The validation it really needs is a single smoke test plus removing the embarrassing stuff (broken image, dead dep, dead setting, broken cast).
