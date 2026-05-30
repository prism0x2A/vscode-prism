/**
 * vscode-prism — PRISM Architecture Intelligence Extension
 *
 * Features:
 *   1. Status bar — shows coherence score (A/B/C/D/F) with color
 *   2. CodeLens — shows "@amber-capability: auth" above tagged files
 *   3. Diagnostics — inline warnings for drift entries
 *   4. Commands — tag file, open dashboard, run scan, show capabilities
 *   5. Auto-refresh — watches .amber/ and .prism/ for changes
 *
 * Architecture: reads local .amber/ and .prism/ files directly.
 * Optionally calls the PRISM dashboard API if running locally.
 */

import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AmberStateEntry {
  capabilities: string[];
  doc_hash: string | null;
  drift?: boolean;
}

interface AmberState {
  files: Record<string, AmberStateEntry>;
}

interface Registry {
  id: string;
  name: string;
  description?: string;
  criticality?: string;
  lifecycle?: string;
}

interface CoherenceHistoryEntry { score: number; grade: string; computedAt: string; target?: string }
interface CoherenceHistory {
  entries: Array<CoherenceHistoryEntry>;
  latest: { score: number; grade: string; label: string } | null;
}

interface DriftEntry {
  file: string;
  kind: string;
}

// ─── State ────────────────────────────────────────────────────────────────────

let statusBarItem: vscode.StatusBarItem;
let diagnosticsCollection: vscode.DiagnosticCollection;
let state: AmberState | null = null;
let registry: Registry[] = [];
let history: CoherenceHistory | null = null;
let driftFiles: Set<string> = new Set();
let watcher: vscode.FileSystemWatcher | null = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getWorkspaceRoot(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  return folders?.[0]?.uri.fsPath ?? null;
}

function safeReadJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function config<T>(key: string, defaultVal: T): T {
  return vscode.workspace.getConfiguration("prism").get<T>(key) ?? defaultVal;
}

// Auto-discover a running prism Studio via the presence file it drops
// at ~/.prism/studio.json on boot. The Electron Studio writes
// { port, pid, url, startedAt } there and deletes it on quit, so reading
// it tells us where to point browser-open commands without the user
// configuring a port that may change between runs.
interface StudioPresence { product: "prism"; port: number; pid: number; url: string; startedAt: string }

function readStudioPresence(): StudioPresence | null {
  try {
    const home = process.env.HOME ?? process.env.USERPROFILE;
    if (!home) return null;
    const raw = fs.readFileSync(path.join(home, ".prism", "studio.json"), "utf8");
    const parsed = JSON.parse(raw) as StudioPresence;
    if (!parsed?.port || !parsed?.url) return null;
    // Stale-pid check: if the recorded PID isn't live, presence is stale.
    try { process.kill(parsed.pid, 0); } catch { return null; }
    return parsed;
  } catch { return null; }
}

/**
 * Pick where dashboard links open based on the user's `prism.openIn` pref:
 *  - "auto" (default): prism Studio if running, otherwise the configured URL
 *  - "studio":         prism Studio always — fails gracefully to URL if down
 *  - "url":            never use Studio, always the configured dashboardUrl
 */
function dashboardUrl(): string {
  const mode = config<"auto" | "studio" | "url">("openIn", "auto");
  const fallback = config("dashboardUrl", "http://localhost:3000");
  if (mode === "url") return fallback;
  const studio = readStudioPresence();
  if (studio) return studio.url;
  if (mode === "studio") {
    vscode.window.showWarningMessage("PRISM Studio isn't running — falling back to the configured URL.");
  }
  return fallback;
}

// ─── Data loading ─────────────────────────────────────────────────────────────

function loadData(root: string): void {
  state = safeReadJson<AmberState>(path.join(root, ".amber", "state.json"));
  registry = safeReadJson<Registry[]>(
    path.join(root, ".prism", "amber-registry.json")
  ) ?? safeReadJson<Registry[]>(
    path.join(root, ".amber", "registry.json")
  ) ?? [];

  // Fallback: workspaces that keep their registry as .amber/capabilities.md
  // (the source of truth in prism) don't have a JSON sidecar. Synthesize
  // minimal Registry entries from the capability IDs referenced in state.json
  // so the sidebar tree, code lenses, and capability picker still work
  // without round-tripping through prism Studio.
  if (registry.length === 0 && state) {
    const ids = new Set<string>();
    for (const entry of Object.values(state.files)) {
      for (const cid of entry.capabilities) ids.add(cid);
    }
    registry = Array.from(ids).map((id) => ({ id, name: id }));
  }
  // Coherence history lives in three possible spots, in order of preference:
  //   1. .prism/green/coherence-history.json (in-repo, legacy)
  //   2. ~/.prism0x2a/.prism/green/workspaces/<key>/coherence-history.json
  //   3. ~/.prism0x2a/.prism/green/coherence-history.json (global default)
  // Studio writes #2 or #3 — the entries carry a `target` field, so we filter
  // by the workspace root to get the score for THIS folder.
  history = safeReadJson<CoherenceHistory>(
    path.join(root, ".prism", "green", "coherence-history.json")
  );
  if (!history || (history.entries ?? []).length === 0) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    const candidates = [
      path.join(home, ".prism0x2a", ".prism", "green", "coherence-history.json"),
    ];
    // Also probe per-workspace dirs (key is opaque; loop over them all).
    const wsDir = path.join(home, ".prism0x2a", ".prism", "green", "workspaces");
    try {
      for (const sub of fs.readdirSync(wsDir)) {
        candidates.push(path.join(wsDir, sub, "coherence-history.json"));
      }
    } catch { /* dir not present yet */ }
    for (const p of candidates) {
      const raw = safeReadJson<CoherenceHistory>(p);
      if (!raw?.entries) continue;
      const ours = raw.entries.filter((e) => !e.target || e.target === root);
      if (ours.length === 0) continue;
      const latestEntry = ours[ours.length - 1];
      history = {
        entries: ours,
        latest: { score: latestEntry.score, grade: latestEntry.grade, label: "" },
      };
      break;
    }
  }

  // Build drift file set
  driftFiles.clear();
  if (state) {
    for (const [filePath, entry] of Object.entries(state.files)) {
      if (entry.drift) {
        driftFiles.add(path.join(root, filePath.replace(/\\/g, path.sep)));
      }
    }
  }

  // Load scan for drift entries
  const scan = safeReadJson<{ drift: DriftEntry[] }>(
    path.join(root, ".amber", "scan.json")
  );
  if (scan?.drift) {
    for (const d of scan.drift) {
      driftFiles.add(path.join(root, d.file.replace(/\\/g, path.sep)));
    }
  }
}

// ─── Status bar ───────────────────────────────────────────────────────────────

function updateStatusBar(): void {
  if (!config("showStatusBar", true)) {
    statusBarItem.hide();
    return;
  }

  const latest = history?.latest ?? history?.entries[history.entries.length - 1] ?? null;

  if (!latest) {
    statusBarItem.text = "$(shield) PRISM";
    statusBarItem.tooltip = "PRISM — No coherence score yet. Run a scan.";
    statusBarItem.backgroundColor = undefined;
    statusBarItem.show();
    return;
  }

  const gradeColors: Record<string, vscode.ThemeColor> = {
    A: new vscode.ThemeColor("statusBarItem.prominentBackground"),
    B: new vscode.ThemeColor("statusBarItem.prominentBackground"),
    F: new vscode.ThemeColor("statusBarItem.errorBackground"),
    D: new vscode.ThemeColor("statusBarItem.warningBackground"),
    C: new vscode.ThemeColor("statusBarItem.warningBackground"),
  };

  const scoreLabel = typeof latest === "object" && "score" in latest ? latest.score : (latest as {score:number}).score;
  const gradeLabel = typeof latest === "object" && "grade" in latest ? (latest as {grade: string}).grade : "?";

  statusBarItem.text = `$(shield) ${scoreLabel} ${gradeLabel}`;
  statusBarItem.tooltip = `PRISM Coherence Score: ${scoreLabel} (${gradeLabel})\nClick to open dashboard`;
  statusBarItem.backgroundColor = gradeColors[gradeLabel];
  statusBarItem.command = "prism.showCoherenceScore";
  statusBarItem.show();
}

// ─── Diagnostics (drift warnings) ────────────────────────────────────────────

function updateDiagnostics(document: vscode.TextDocument): void {
  if (!config("showDriftDiagnostics", true)) {
    diagnosticsCollection.clear();
    return;
  }

  const filePath = document.uri.fsPath;
  const root = getWorkspaceRoot();
  if (!root) return;

  if (!driftFiles.has(filePath)) {
    diagnosticsCollection.delete(document.uri);
    return;
  }

  // Find the drift kind for this file
  const relPath = path.relative(root, filePath).replace(/\\/g, "/");
  const entry = state?.files[relPath];
  const driftKind = entry ? "documentation drift" : "drift detected";

  const caps = entry?.capabilities ?? [];
  const capNames = caps.map((id) => registry.find((r) => r.id === id)?.name ?? id).join(", ");

  // Place warning at top of file (first non-empty line)
  const firstLine = document.lineAt(0);
  const range = new vscode.Range(firstLine.range.start, firstLine.range.end);

  const diagnostic = new vscode.Diagnostic(
    range,
    `PRISM AMBER: ${driftKind} in capability "${capNames || relPath}". ` +
    `Run PRISM › Auto-heal Drift to fix.`,
    vscode.DiagnosticSeverity.Warning
  );
  diagnostic.source = "PRISM AMBER";
  diagnostic.code = "amber-drift";

  diagnosticsCollection.set(document.uri, [diagnostic]);
}

// ─── CodeLens provider ────────────────────────────────────────────────────────

class PrismCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  refresh(): void {
    this._onDidChangeCodeLenses.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!config("showCapabilityLens", true)) return [];

    const root = getWorkspaceRoot();
    if (!root || !state) return [];

    const relPath = path.relative(root, document.uri.fsPath).replace(/\\/g, "/");
    const entry = state.files[relPath];
    if (!entry || entry.capabilities.length === 0) return [];

    const lenses: vscode.CodeLens[] = [];
    const firstLine = document.lineAt(0);

    for (const capId of entry.capabilities) {
      const cap = registry.find((r) => r.id === capId);
      const label = cap ? `${cap.name} (${capId})` : capId;
      const isDrifted = driftFiles.has(document.uri.fsPath);

      lenses.push(new vscode.CodeLens(firstLine.range, {
        title: `🟡 AMBER: ${label}${isDrifted ? " ⚠ drift" : ""}`,
        command: "prism.showCapabilities",
        arguments: [capId],
        tooltip: cap?.description ?? `Capability: ${capId}`,
      }));
    }

    return lenses;
  }
}

// ─── Quick Pick: tag file ─────────────────────────────────────────────────────

async function tagCurrentFile(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("PRISM: No active file to tag.");
    return;
  }

  if (registry.length === 0) {
    vscode.window.showWarningMessage("PRISM: No capability registry found (.amber/capabilities.md).");
    return;
  }

  const items = registry.map((cap) => ({
    label: cap.name,
    description: cap.id,
    detail: cap.description,
    id: cap.id,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Select a capability to tag this file with",
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (!picked) return;

  // Insert @amber-capability tag at top of file
  const document = editor.document;
  const text = document.getText();
  const tag = `/**\n * @amber-capability ${picked.id}\n */\n`;

  if (text.includes("@amber-capability")) {
    vscode.window.showInformationMessage(`PRISM: File already has a capability tag. Edit it manually.`);
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  edit.insert(document.uri, new vscode.Position(0, 0), tag);
  await vscode.workspace.applyEdit(edit);
  await document.save();

  vscode.window.showInformationMessage(`PRISM: Tagged file with @amber-capability ${picked.id} ✓`);
}

// ─── Show coherence score panel ───────────────────────────────────────────────

function showCoherenceScore(): void {
  const latest = history?.latest
    ?? (history?.entries.length ? history.entries[history.entries.length - 1] : null);

  if (!latest) {
    vscode.window.showInformationMessage(
      "PRISM: No coherence score yet. Run an AMBER scan in the dashboard first.",
      "Open Dashboard"
    ).then((choice) => {
      if (choice === "Open Dashboard") {
        vscode.env.openExternal(vscode.Uri.parse(`${dashboardUrl()}/green`));
      }
    });
    return;
  }

  const score = (latest as {score:number}).score;
  const grade = (latest as {grade:string}).grade;
  const label = (latest as {label?:string}).label ?? "";

  const actions = ["Open Full Dashboard", "View History"];
  vscode.window.showInformationMessage(
    `PRISM Architecture Score: ${score} (${grade} — ${label})`,
    ...actions
  ).then((choice) => {
    if (choice === "Open Full Dashboard") {
      vscode.env.openExternal(vscode.Uri.parse(`${dashboardUrl()}/green`));
    } else if (choice === "View History") {
      vscode.env.openExternal(vscode.Uri.parse(`${dashboardUrl()}/green/coherence-history`));
    }
  });
}

// ─── Open dashboard ───────────────────────────────────────────────────────────

function openDashboard(): void {
  vscode.env.openExternal(vscode.Uri.parse(dashboardUrl()));
}

// ─── Show capabilities panel ──────────────────────────────────────────────────

async function showCapabilities(capId?: string): Promise<void> {
  if (capId) {
    vscode.env.openExternal(
      vscode.Uri.parse(`${dashboardUrl()}/amber/capabilities/${encodeURIComponent(capId)}`)
    );
    return;
  }

  if (registry.length === 0) {
    vscode.window.showWarningMessage("PRISM: No capability registry found.");
    return;
  }

  const items = registry.map((cap) => ({
    label: cap.name,
    description: `${cap.id} · ${cap.criticality ?? "medium"}`,
    detail: cap.description,
    id: cap.id,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Browse AMBER Capabilities",
  });

  if (picked) {
    vscode.env.openExternal(
      vscode.Uri.parse(`${dashboardUrl()}/amber/capabilities/${encodeURIComponent(picked.id)}`)
    );
  }
}

// ─── Heal drift ───────────────────────────────────────────────────────────────

async function healDrift(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const root = getWorkspaceRoot();
  if (!root) return;

  const relPath = path.relative(root, editor.document.uri.fsPath).replace(/\\/g, "/");

  if (!driftFiles.has(editor.document.uri.fsPath)) {
    vscode.window.showInformationMessage("PRISM: No drift detected in this file.");
    return;
  }

  const url = `${dashboardUrl()}/api/amber/ai/heal-drift?target=${encodeURIComponent(root)}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ driftFile: relPath, kind: "doc_hash_mismatch" }),
    });
    const data = await res.json() as { action: string; reasoning: string; newDoc?: string };

    if (!res.ok) {
      vscode.window.showErrorMessage(`PRISM: Heal-drift failed — ${(data as {error?:string}).error ?? "unknown error"}`);
      return;
    }

    if (data.action === "update_doc" && data.newDoc) {
      const choice = await vscode.window.showInformationMessage(
        `PRISM suggests updating @amber-doc:\n"${data.newDoc}"`,
        "Apply", "Cancel"
      );
      if (choice === "Apply") {
        // Apply the new doc to the file's @amber-doc tag
        const text = editor.document.getText();
        const docMatch = text.match(/@amber-doc\s+([^\n*]+)/);
        if (docMatch) {
          const edit = new vscode.WorkspaceEdit();
          const start = editor.document.positionAt(text.indexOf(docMatch[0]));
          const end = editor.document.positionAt(text.indexOf(docMatch[0]) + docMatch[0].length);
          edit.replace(editor.document.uri, new vscode.Range(start, end), `@amber-doc ${data.newDoc}`);
          await vscode.workspace.applyEdit(edit);
          await editor.document.save();
          vscode.window.showInformationMessage("PRISM: @amber-doc updated ✓");
        }
      }
    } else {
      vscode.window.showInformationMessage(
        `PRISM suggests: ${data.action} — ${data.reasoning}`,
        "Open Dashboard"
      ).then((c) => {
        if (c === "Open Dashboard") openDashboard();
      });
    }
  } catch {
    vscode.window.showErrorMessage("PRISM: Could not reach dashboard API. Is prism0x2A running?");
  }
}

// ─── Open capability for current file ─────────────────────────────────────────

function openCapabilityForCurrentFile(): void {
  const editor = vscode.window.activeTextEditor;
  const root = getWorkspaceRoot();
  if (!editor || !root || !state) {
    vscode.window.showInformationMessage("PRISM: No AMBER state for this workspace.");
    return;
  }
  const rel = path.relative(root, editor.document.uri.fsPath).replace(/\\/g, "/");
  const caps = state.files[rel]?.capabilities ?? [];
  if (caps.length === 0) {
    vscode.window.showInformationMessage("PRISM: This file isn't tagged with any capability yet.");
    return;
  }
  if (caps.length === 1) {
    void showCapabilities(caps[0]);
    return;
  }
  void vscode.window.showQuickPick(caps, { placeHolder: "Open which capability?" })
    .then((pick) => { if (pick) void showCapabilities(pick); });
}

// ─── Code Actions (💡 quick-fix bulb on drift diagnostics) ────────────────────

class PrismCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const driftDiags = context.diagnostics.filter(
      (d) => d.source === "PRISM AMBER" && d.code === "amber-drift",
    );
    if (driftDiags.length === 0) return [];

    const actions: vscode.CodeAction[] = [];

    const heal = new vscode.CodeAction(
      "PRISM: Auto-heal drift (call AI to update @amber-doc)",
      vscode.CodeActionKind.QuickFix,
    );
    heal.command = { command: "prism.healDrift", title: "Heal drift" };
    heal.diagnostics = driftDiags;
    heal.isPreferred = true;
    actions.push(heal);

    const retag = new vscode.CodeAction(
      "PRISM: Re-tag this file with a different capability",
      vscode.CodeActionKind.QuickFix,
    );
    retag.command = { command: "prism.tagFile", title: "Re-tag" };
    retag.diagnostics = driftDiags;
    actions.push(retag);

    const open = new vscode.CodeAction(
      "PRISM: Open this capability in Studio",
      vscode.CodeActionKind.QuickFix,
    );
    open.command = { command: "prism.openCapability", title: "Open capability" };
    open.diagnostics = driftDiags;
    actions.push(open);

    const ask = new vscode.CodeAction(
      "PRISM: Ask PRISM about this drift",
      vscode.CodeActionKind.QuickFix,
    );
    ask.command = {
      command: "prism.openChat",
      title: "Ask PRISM",
      arguments: [{ seed: `Why is ${path.basename(document.fileName)} drifting from its AMBER doc?` }],
    };
    ask.diagnostics = driftDiags;
    actions.push(ask);

    return actions;
  }
}

// ─── Sidebar: Capabilities TreeView ───────────────────────────────────────────

class CapabilityTreeItem extends vscode.TreeItem {
  constructor(
    public readonly cap: Registry,
    public readonly fileCount: number,
    public readonly hasDrift: boolean,
  ) {
    super(cap.name, vscode.TreeItemCollapsibleState.None);
    this.id = cap.id;
    this.description = `${fileCount} file${fileCount === 1 ? "" : "s"}${hasDrift ? " ⚠" : ""}`;
    this.tooltip = `${cap.id}\n${cap.description ?? ""}${cap.criticality ? `\nCriticality: ${cap.criticality}` : ""}`;
    this.iconPath = new vscode.ThemeIcon(
      hasDrift ? "warning" : "symbol-namespace",
      hasDrift ? new vscode.ThemeColor("editorWarning.foreground") : undefined,
    );
    this.command = {
      command: "prism.showCapabilities",
      title: "Open",
      arguments: [cap.id],
    };
    this.contextValue = "prismCapability";
  }
}

class CapabilityTreeProvider implements vscode.TreeDataProvider<CapabilityTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void { this._onDidChangeTreeData.fire(); }

  getTreeItem(item: CapabilityTreeItem): vscode.TreeItem { return item; }

  getChildren(): CapabilityTreeItem[] {
    if (registry.length === 0) return [];
    const counts = new Map<string, { files: number; drift: boolean }>();
    if (state) {
      for (const [rel, entry] of Object.entries(state.files)) {
        for (const cid of entry.capabilities) {
          const c = counts.get(cid) ?? { files: 0, drift: false };
          c.files += 1;
          if (entry.drift) c.drift = true;
          counts.set(cid, c);
          void rel;
        }
      }
    }
    return registry
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((cap) => {
        const c = counts.get(cap.id) ?? { files: 0, drift: false };
        return new CapabilityTreeItem(cap, c.files, c.drift);
      });
  }
}

// ─── Sidebar: Coherence Webview ───────────────────────────────────────────────

class CoherenceWebviewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((msg: { type: string }) => {
      if (msg.type === "open-dashboard") {
        void vscode.env.openExternal(vscode.Uri.parse(`${dashboardUrl()}/green`));
      }
      if (msg.type === "open-chat") {
        void vscode.commands.executeCommand("prism.openChat");
      }
    });
    this.render();
  }

  refresh(): void { this.render(); }

  private render(): void {
    if (!this.view) return;
    const latest = history?.latest
      ?? (history?.entries.length ? history.entries[history.entries.length - 1] : null);
    const totalCaps = registry.length;
    const driftCount = driftFiles.size;
    const fileCount = state ? Object.keys(state.files).length : 0;
    const root = getWorkspaceRoot();
    const stateExists = root ? fs.existsSync(path.join(root, ".amber", "state.json")) : false;

    const score = latest ? (latest as { score: number }).score : null;
    const grade = latest ? (latest as { grade: string }).grade : "—";
    const gradeColor = grade === "A" ? "#10b981"
      : grade === "B" ? "#84cc16"
      : grade === "C" ? "#facc15"
      : grade === "D" ? "#f97316"
      : grade === "F" ? "#ef4444"
      : "var(--vscode-foreground)";

    // Compact layout: score and grade on one row, stats as a horizontal
    // strip, workspace info collapsed to one line when healthy. Total
    // height target ≈ 180px so users don't have to scroll between
    // Capabilities and Coherence in default sidebar splits.
    const wsLine = root
      ? `${escapeHtml(root.replace(process.env.HOME ?? "", "~"))} ${stateExists ? "✓" : "<span class=\"missing\">✗ no scan</span>"}`
      : "no folder open";

    this.view.webview.html = /* html */ `
      <!doctype html><html><head><meta charset="utf-8"/>
      <style>
        body { font-family: var(--vscode-font-family); padding: 8px 10px; color: var(--vscode-foreground); font-size: 12px; }
        .head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
        .score { font-size: 28px; font-weight: 700; color: ${gradeColor}; line-height: 1; font-variant-numeric: tabular-nums; }
        .grade { opacity: 0.7; }
        .empty { opacity: 0.6; text-align: center; padding: 8px 0; }
        .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; margin-bottom: 8px; }
        .stat { padding: 4px 6px; background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 3px; text-align: center; }
        .stat .n { font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.1; }
        .stat .l { font-size: 10px; opacity: 0.65; text-transform: uppercase; letter-spacing: 0.04em; }
        .warn .n { color: var(--vscode-editorWarning-foreground); }
        .ws { font-size: 10px; opacity: 0.7; margin-bottom: 6px; word-break: break-all; font-family: var(--vscode-editor-font-family); }
        .ws .missing { color: var(--vscode-editorWarning-foreground); }
        .row { display: flex; gap: 6px; }
        button { flex: 1; padding: 4px 8px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; border-radius: 3px; cursor: pointer; font-family: inherit; font-size: 11px; }
        button:hover { background: var(--vscode-button-hoverBackground); }
      </style></head><body>
        <div class="head">
          ${score !== null
            ? `<span class="score">${score}</span><span class="grade">Grade ${grade}</span>`
            : `<span class="empty">No score yet — run AMBER scan in Studio</span>`}
        </div>
        <div class="stats">
          <div class="stat"><div class="n">${totalCaps}</div><div class="l">Caps</div></div>
          <div class="stat"><div class="n">${fileCount}</div><div class="l">Tagged</div></div>
          <div class="stat ${driftCount > 0 ? "warn" : ""}"><div class="n">${driftCount}</div><div class="l">Drift</div></div>
        </div>
        <div class="ws" title="${escapeHtml(root ?? "")}">${wsLine}</div>
        <div class="row">
          <button onclick="vs.postMessage({type:'open-dashboard'})">Studio</button>
          <button onclick="vs.postMessage({type:'open-chat'})">Ask PRISM</button>
        </div>
        <script>const vs = acquireVsCodeApi();</script>
      </body></html>`;
  }
}

// ─── Sidebar: Chat Webview ────────────────────────────────────────────────────

interface ChatMessage { role: "user" | "assistant"; text: string }
const chatHistory: ChatMessage[] = [];

class ChatWebviewProvider implements vscode.WebviewViewProvider {
  view: vscode.WebviewView | null = null;

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage(async (msg: { type: string; text?: string }) => {
      if (msg.type === "send" && msg.text) {
        await this.handleSend(msg.text);
      }
      if (msg.type === "clear") {
        chatHistory.length = 0;
        this.render();
      }
    });
    this.render();
  }

  seed(prompt: string): void {
    // Pre-fill the input next render — easiest: push as pending user msg via message
    if (!this.view) return;
    void this.view.webview.postMessage({ type: "seed", text: prompt });
  }

  private async handleSend(text: string): Promise<void> {
    chatHistory.push({ role: "user", text });
    chatHistory.push({ role: "assistant", text: "…thinking" });
    this.render();

    const root = getWorkspaceRoot();
    const editor = vscode.window.activeTextEditor;
    const relFile = editor && root
      ? path.relative(root, editor.document.uri.fsPath).replace(/\\/g, "/")
      : null;

    try {
      const url = `${dashboardUrl()}/api/amber/ai/chat${root ? `?target=${encodeURIComponent(root)}` : ""}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: text,
          context: { file: relFile, capabilities: relFile && state ? (state.files[relFile]?.capabilities ?? []) : [] },
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { reply?: string; suggestion?: { file?: string; newDoc?: string } };
      chatHistory.pop();
      chatHistory.push({ role: "assistant", text: data.reply ?? "(no reply)" });
      this.render();

      if (data.suggestion?.newDoc && relFile) {
        const apply = await vscode.window.showInformationMessage(
          `PRISM suggests updating @amber-doc in ${relFile}.`,
          "Apply", "Dismiss",
        );
        if (apply === "Apply" && editor) await applyDocSuggestion(editor, data.suggestion.newDoc);
      }
    } catch (err: unknown) {
      chatHistory.pop();
      const msg = err instanceof Error ? err.message : String(err);
      chatHistory.push({
        role: "assistant",
        text: `⚠ Could not reach PRISM Studio (${msg}). Make sure it's running, or set \`prism.dashboardUrl\`.`,
      });
      this.render();
    }
  }

  private render(): void {
    if (!this.view) return;
    const bubbles = chatHistory.map((m) => {
      const bg = m.role === "user"
        ? "var(--vscode-textBlockQuote-background)"
        : "var(--vscode-editor-inactiveSelectionBackground)";
      return `<div class="bubble" style="background:${bg}"><div class="role">${m.role}</div><div class="body">${escapeHtml(m.text)}</div></div>`;
    }).join("");
    this.view.webview.html = /* html */ `
      <!doctype html><html><head><meta charset="utf-8"/>
      <style>
        body { font-family: var(--vscode-font-family); padding: 8px; color: var(--vscode-foreground); display: flex; flex-direction: column; height: 100vh; box-sizing: border-box; margin: 0; }
        #log { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding-bottom: 8px; }
        .bubble { padding: 8px 10px; border-radius: 6px; font-size: 12px; line-height: 1.45; }
        .role { font-size: 10px; opacity: 0.6; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
        .body { white-space: pre-wrap; word-break: break-word; }
        form { display: flex; gap: 6px; border-top: 1px solid var(--vscode-panel-border); padding-top: 8px; }
        textarea { flex: 1; resize: none; padding: 6px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; font-family: inherit; font-size: 12px; min-height: 48px; }
        button { padding: 6px 10px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; border-radius: 4px; cursor: pointer; font-family: inherit; font-size: 12px; }
        button.secondary { background: transparent; color: var(--vscode-foreground); opacity: 0.7; }
        .empty { opacity: 0.6; font-size: 12px; text-align: center; padding: 30px 10px; }
      </style></head><body>
        <div id="log">${bubbles || '<div class="empty">Ask about a file, capability, or drift.<br/>Active file + AMBER context is sent automatically.</div>'}</div>
        <form id="f">
          <textarea id="t" placeholder="Ask PRISM…" rows="2"></textarea>
          <div style="display:flex;flex-direction:column;gap:4px;">
            <button type="submit">Send</button>
            <button type="button" class="secondary" onclick="vs.postMessage({type:'clear'})">Clear</button>
          </div>
        </form>
        <script>
          const vs = acquireVsCodeApi();
          const f = document.getElementById('f'), t = document.getElementById('t');
          const log = document.getElementById('log'); log.scrollTop = log.scrollHeight;
          f.addEventListener('submit', (e) => { e.preventDefault(); const v = t.value.trim(); if (!v) return; vs.postMessage({type:'send', text:v}); t.value=''; });
          t.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { f.requestSubmit(); } });
          window.addEventListener('message', (e) => { if (e.data?.type === 'seed') { t.value = e.data.text; t.focus(); } });
        </script>
      </body></html>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

async function applyDocSuggestion(editor: vscode.TextEditor, newDoc: string): Promise<void> {
  const text = editor.document.getText();
  const m = text.match(/@amber-doc\s+([^\n*]+)/);
  if (!m) {
    vscode.window.showWarningMessage("PRISM: No @amber-doc tag in this file — can't auto-apply.");
    return;
  }
  const start = editor.document.positionAt(text.indexOf(m[0]));
  const end = editor.document.positionAt(text.indexOf(m[0]) + m[0].length);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(editor.document.uri, new vscode.Range(start, end), `@amber-doc ${newDoc}`);
  await vscode.workspace.applyEdit(edit);
  await editor.document.save();
  vscode.window.showInformationMessage("PRISM: @amber-doc updated ✓");
}

// ─── PR Review Mode ───────────────────────────────────────────────────────────

interface DiffStat { file: string; added: number; removed: number }

function gitDiffNameStat(root: string, base: string): Promise<DiffStat[]> {
  return new Promise((resolve) => {
    execFile("git", ["diff", "--numstat", `${base}...HEAD`], { cwd: root, maxBuffer: 5_000_000 }, (err, stdout) => {
      if (err) { resolve([]); return; }
      const lines = stdout.split("\n").filter(Boolean);
      const stats: DiffStat[] = [];
      for (const line of lines) {
        const [a, r, f] = line.split("\t");
        if (!f) continue;
        stats.push({ file: f, added: Number(a) || 0, removed: Number(r) || 0 });
      }
      resolve(stats);
    });
  });
}

function detectBaseBranch(root: string): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd: root }, (err, stdout) => {
      if (!err && stdout.trim()) { resolve(stdout.trim().replace("refs/remotes/origin/", "origin/")); return; }
      execFile("git", ["rev-parse", "--verify", "origin/main"], { cwd: root }, (e2) => {
        resolve(e2 ? "origin/master" : "origin/main");
      });
    });
  });
}

async function reviewBranch(context: vscode.ExtensionContext): Promise<void> {
  const root = getWorkspaceRoot();
  if (!root) { vscode.window.showWarningMessage("PRISM: No workspace open."); return; }
  const base = await detectBaseBranch(root);
  const diff = await gitDiffNameStat(root, base);
  if (diff.length === 0) {
    vscode.window.showInformationMessage(`PRISM: No changes vs ${base}.`);
    return;
  }

  const capImpact = new Map<string, { name: string; files: string[]; drift: boolean }>();
  const untagged: string[] = [];
  for (const d of diff) {
    const caps = state?.files[d.file]?.capabilities ?? [];
    const drifted = state?.files[d.file]?.drift ?? false;
    if (caps.length === 0) { untagged.push(d.file); continue; }
    for (const cid of caps) {
      const reg = registry.find((r) => r.id === cid);
      const e = capImpact.get(cid) ?? { name: reg?.name ?? cid, files: [], drift: false };
      e.files.push(d.file);
      if (drifted) e.drift = true;
      capImpact.set(cid, e);
    }
  }

  const panel = vscode.window.createWebviewPanel(
    "prism.prReview", `PRISM: Branch Review vs ${base}`,
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.webview.onDidReceiveMessage((m: { type: string; file?: string; cap?: string }) => {
    if (m.type === "open-file" && m.file) {
      void vscode.window.showTextDocument(vscode.Uri.file(path.join(root, m.file)));
    }
    if (m.type === "open-cap" && m.cap) {
      void showCapabilities(m.cap);
    }
  });

  const capRows = Array.from(capImpact.entries()).map(([cid, e]) => `
    <tr>
      <td><a href="#" onclick="vs.postMessage({type:'open-cap',cap:'${cid}'});return false;">${escapeHtml(e.name)}</a> ${e.drift ? '<span class="warn">⚠ drift</span>' : ""}</td>
      <td>${e.files.length}</td>
      <td>${e.files.map((f) => `<a href="#" onclick="vs.postMessage({type:'open-file',file:${JSON.stringify(f)}});return false;">${escapeHtml(path.basename(f))}</a>`).join("<br/>")}</td>
    </tr>`).join("");

  const untaggedRows = untagged.length === 0 ? "" : `
    <h3>Untagged files (${untagged.length})</h3>
    <p class="hint">These touched files aren't in any capability — consider tagging.</p>
    <ul>${untagged.map((f) => `<li><a href="#" onclick="vs.postMessage({type:'open-file',file:${JSON.stringify(f)}});return false;">${escapeHtml(f)}</a></li>`).join("")}</ul>`;

  panel.webview.html = /* html */ `
    <!doctype html><html><head><meta charset="utf-8"/>
    <style>
      body { font-family: var(--vscode-font-family); padding: 18px 24px; color: var(--vscode-foreground); }
      h1 { font-size: 18px; margin-bottom: 4px; } h3 { font-size: 14px; margin-top: 24px; }
      .meta { opacity: 0.7; font-size: 12px; margin-bottom: 18px; }
      table { width: 100%; border-collapse: collapse; font-size: 12px; }
      th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
      th { font-weight: 600; opacity: 0.7; }
      a { color: var(--vscode-textLink-foreground); text-decoration: none; }
      a:hover { text-decoration: underline; }
      .warn { color: var(--vscode-editorWarning-foreground); font-size: 11px; margin-left: 4px; }
      .hint { opacity: 0.65; font-size: 12px; }
      .empty { opacity: 0.7; font-style: italic; }
    </style></head><body>
      <h1>Branch review</h1>
      <div class="meta">${diff.length} file${diff.length===1?"":"s"} changed vs <code>${escapeHtml(base)}</code> · ${capImpact.size} capabilit${capImpact.size===1?"y":"ies"} affected</div>
      <h3>Capability impact</h3>
      ${capImpact.size === 0
        ? '<p class="empty">No tagged capabilities touched.</p>'
        : `<table><thead><tr><th>Capability</th><th>Files</th><th>Touched</th></tr></thead><tbody>${capRows}</tbody></table>`}
      ${untaggedRows}
      <script>const vs = acquireVsCodeApi();</script>
    </body></html>`;
  context.subscriptions.push(panel);
}

// ─── Watcher setup ────────────────────────────────────────────────────────────

function setupWatcher(
  root: string,
  codeLensProvider: PrismCodeLensProvider,
  capTree: CapabilityTreeProvider,
  coherence: CoherenceWebviewProvider,
): void {
  watcher?.dispose();
  watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(root, "{.amber/**,.prism/**}")
  );
  const onAny = () => {
    loadData(root);
    updateStatusBar();
    codeLensProvider.refresh();
    capTree.refresh();
    coherence.refresh();
    for (const editor of vscode.window.visibleTextEditors) {
      updateDiagnostics(editor.document);
    }
  };
  watcher.onDidChange(onAny);
  watcher.onDidCreate(onAny);
  watcher.onDidDelete(onAny);
}

// ─── Activation ───────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  const root = getWorkspaceRoot();

  // Status bar
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(statusBarItem);

  // Diagnostics
  diagnosticsCollection = vscode.languages.createDiagnosticCollection("prism-amber");
  context.subscriptions.push(diagnosticsCollection);

  // CodeLens
  const codeLensProvider = new PrismCodeLensProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      { scheme: "file", pattern: "**/*.{ts,tsx,js,jsx,py,go,rs,java,cs}" },
      codeLensProvider
    )
  );

  // Quick-fix code actions on AMBER drift diagnostics
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file", pattern: "**/*.{ts,tsx,js,jsx,py,go,rs,java,cs,php,rb,kt,swift,cpp,cbl}" },
      new PrismCodeActionProvider(),
      { providedCodeActionKinds: PrismCodeActionProvider.providedCodeActionKinds },
    ),
  );

  // Sidebar — capability tree + coherence webview + chat webview
  const capTree = new CapabilityTreeProvider();
  const coherence = new CoherenceWebviewProvider();
  const chat = new ChatWebviewProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("prism.capabilitiesView", capTree),
    vscode.window.registerWebviewViewProvider("prism.coherenceView", coherence),
    vscode.window.registerWebviewViewProvider("prism.chatView", chat),
  );

  // Load initial data
  if (root) {
    loadData(root);
    updateStatusBar();
    setupWatcher(root, codeLensProvider, capTree, coherence);
  }

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("prism.openDashboard", openDashboard),
    vscode.commands.registerCommand("prism.showCoherenceScore", showCoherenceScore),
    vscode.commands.registerCommand("prism.tagFile", tagCurrentFile),
    vscode.commands.registerCommand("prism.showCapabilities", showCapabilities),
    vscode.commands.registerCommand("prism.healDrift", healDrift),
    vscode.commands.registerCommand("prism.openCapability", openCapabilityForCurrentFile),
    vscode.commands.registerCommand("prism.refreshCapabilities", () => {
      if (root) loadData(root);
      capTree.refresh();
      coherence.refresh();
      codeLensProvider.refresh();
      updateStatusBar();
    }),
    vscode.commands.registerCommand("prism.openChat", async (arg?: { seed?: string }) => {
      await vscode.commands.executeCommand("prism.chatView.focus");
      if (arg?.seed) chat.seed(arg.seed);
    }),
    vscode.commands.registerCommand("prism.reviewBranch", () => reviewBranch(context)),
    vscode.commands.registerCommand("prism.runScan", async () => {
      vscode.env.openExternal(vscode.Uri.parse(`${dashboardUrl()}/amber`));
      vscode.window.showInformationMessage("PRISM: Open the dashboard to run a scan.");
    })
  );

  // Diagnostics on editor events
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) updateDiagnostics(editor.document);
    }),
    vscode.workspace.onDidOpenTextDocument(updateDiagnostics),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (root) {
        // Re-load data in case a .amber file was saved
        const rel = path.relative(root, doc.uri.fsPath);
        if (rel.startsWith(".amber") || rel.startsWith(".prism")) {
          loadData(root);
          updateStatusBar();
          codeLensProvider.refresh();
        }
        updateDiagnostics(doc);
      }
    })
  );

  // Initial diagnostics for open editors
  for (const editor of vscode.window.visibleTextEditors) {
    updateDiagnostics(editor.document);
  }
}

export function deactivate(): void {
  watcher?.dispose();
  statusBarItem?.dispose();
  diagnosticsCollection?.dispose();
}
