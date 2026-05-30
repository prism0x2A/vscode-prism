# PRISM — Architecture Intelligence for VS Code

> Bring AMBER capabilities, drift warnings, and the Architecture Coherence Score directly into your editor.

---

## Features

### 🔢 Coherence Score in Status Bar
The Architecture Coherence Score (0–100, A–F) appears in your status bar at all times. Click to see a breakdown and open the dashboard.

### 🧩 Capability CodeLens
Files tagged with `@amber-capability` show an inline lens at the top:
```
🟡 AMBER: Authentication (auth)
```
Click to jump to the capability detail in the PRISM dashboard.

### ⚠️ Drift Diagnostics + Quick-Fix Actions
Files with AMBER documentation drift show inline warnings. Click the 💡 lightbulb (or `Cmd+.`) for one-click fixes:
- **Auto-heal drift** — AI rewrites the stale `@amber-doc`
- **Re-tag this file** — pick a different capability
- **Open in Studio** — jump to the capability detail
- **Ask PRISM about this drift** — opens the chat panel with context

### 🪟 PRISM Sidebar
A new activity bar container with three live views:
- **Capabilities** — tree of every capability in your workspace with file counts and drift markers
- **Coherence** — score, grade, tagged-file count, drifting-file count, quick actions
- **Ask PRISM** — chat with PRISM about the active file (auto-attaches AMBER context)

### 💬 Inline Chat ("Ask PRISM")
Open with `Cmd+Shift+P → PRISM: Ask PRISM` or via the sidebar. Sends your prompt + active file + tagged capabilities to PRISM Studio. If the LLM suggests an updated `@amber-doc`, applying it is one click.

### 🔀 PR Review Mode
`PRISM: Review Current Branch` — runs `git diff` against your base branch, maps every touched file to its capabilities, and opens a webview showing which capabilities the branch impacts (and which touched files are untagged).

### ⚡ Commands
Access all PRISM actions via the Command Palette (`Cmd+Shift+P`):

| Command | What it does |
|---------|-------------|
| `PRISM: Open Dashboard` | Open prism0x2A in your browser or Studio |
| `PRISM: Ask PRISM` | Open the inline chat panel |
| `PRISM: Review Current Branch` | AMBER impact analysis for the current branch |
| `PRISM: Tag This File with Capability` | QuickPick to add `@amber-capability` to current file |
| `PRISM: Open Capability for This File` | Jump to the capability this file belongs to |
| `PRISM: Show All Capabilities` | Browse registry, jump to dashboard detail |
| `PRISM: Show Coherence Score` | Popup with current score + grade |
| `PRISM: Auto-heal Drift in This File` | AI suggests updated `@amber-doc` |
| `PRISM: Run AMBER Scan` | Opens AMBER page in dashboard |

### 🖱️ Context Menu
Right-click any source file:
- **PRISM: Tag This File with Capability** — add a capability tag
- **PRISM: Open Capability for This File** — jump to dashboard detail
- **PRISM: Auto-heal Drift** — fix stale documentation
- **PRISM: Ask PRISM** — open chat with file context

---

## Requirements

1. **prism0x2A** running locally (`npx prism0x2a` or `http://localhost:3000`)
2. Project has `.amber/capabilities.md` (AMBER registry)
3. At least one AMBER scan run (`.amber/state.json` exists)

---

## Setup

1. Install the extension from the VS Code Marketplace
2. Start prism0x2A: `npx prism0x2a` in your project root
3. The extension activates automatically when it detects `.amber/capabilities.md`

---

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `prism.dashboardUrl` | `http://localhost:3000` | URL of your prism0x2A instance |
| `prism.showStatusBar` | `true` | Show coherence score in status bar |
| `prism.showDriftDiagnostics` | `true` | Show inline drift warnings |
| `prism.showCapabilityLens` | `true` | Show CodeLens on tagged files |
| `prism.autoRefresh` | `true` | Auto-refresh when PRISM files change |

---

## How it works

The extension reads `.amber/state.json`, `.prism/green/coherence-history.json`, and the capability registry directly from your filesystem — no server round-trips for reading. API calls (heal-drift, tag) go to your local prism0x2A dashboard.

**Zero telemetry.** No data leaves your machine.

---

## Tag a file manually

Add to the top of any source file:

```typescript
/**
 * @amber-capability auth
 * @amber-doc Handles JWT verification and session refresh.
 */
```

Or use **PRISM: Tag This File with Capability** from the command palette for a guided QuickPick.

---

Built with ❤️ by [prism0x2A](https://prism0x2a.dev)
