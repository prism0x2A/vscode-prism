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

interface CoherenceHistory {
  entries: Array<{ score: number; grade: string; computedAt: string }>;
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
  history = safeReadJson<CoherenceHistory>(
    path.join(root, ".prism", "green", "coherence-history.json")
  );

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

// ─── Watcher setup ────────────────────────────────────────────────────────────

function setupWatcher(root: string, codeLensProvider: PrismCodeLensProvider): void {
  watcher?.dispose();
  watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(root, "{.amber/**,.prism/**}")
  );
  watcher.onDidChange(() => {
    loadData(root);
    updateStatusBar();
    codeLensProvider.refresh();
    // Refresh diagnostics for open editors
    for (const editor of vscode.window.visibleTextEditors) {
      updateDiagnostics(editor.document);
    }
  });
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

  // Load initial data
  if (root) {
    loadData(root);
    updateStatusBar();
    setupWatcher(root, codeLensProvider);
  }

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("prism.openDashboard", openDashboard),
    vscode.commands.registerCommand("prism.showCoherenceScore", showCoherenceScore),
    vscode.commands.registerCommand("prism.tagFile", tagCurrentFile),
    vscode.commands.registerCommand("prism.showCapabilities", showCapabilities),
    vscode.commands.registerCommand("prism.healDrift", healDrift),
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
