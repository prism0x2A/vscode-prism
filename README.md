# PRISM — Architecture Intelligence for VS Code

> Bring AMBER capabilities, drift warnings, and the Architecture Coherence Score directly into your editor.

---

## Features

### 🔢 Coherence Score in Status Bar
The Architecture Coherence Score (0–100, A–F) appears in your status bar at all times. Click to see a breakdown and open the dashboard.

![Status Bar](media/statusbar.png)

### 🧩 Capability CodeLens
Files tagged with `@amber-capability` show an inline lens at the top:
```
🟡 AMBER: Authentication (auth)
```
Click to jump to the capability detail in the PRISM dashboard.

### ⚠️ Drift Diagnostics
Files with AMBER documentation drift show inline warnings. The yellow squiggle tells you *which capability* has drifted and offers a one-click heal.

### ⚡ Commands
Access all PRISM actions via the Command Palette (`Cmd+Shift+P`):

| Command | What it does |
|---------|-------------|
| `PRISM: Open Dashboard` | Open prism0x2A in your browser |
| `PRISM: Tag This File with Capability` | QuickPick to add `@amber-capability` to current file |
| `PRISM: Show All Capabilities` | Browse registry, jump to dashboard detail |
| `PRISM: Show Coherence Score` | Popup with current score + grade |
| `PRISM: Auto-heal Drift in This File` | AI suggests updated `@amber-doc` |
| `PRISM: Run AMBER Scan` | Opens AMBER page in dashboard |

### 🖱️ Context Menu
Right-click any source file:
- **PRISM: Tag This File with Capability** — add a capability tag
- **PRISM: Auto-heal Drift** — fix stale documentation

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
