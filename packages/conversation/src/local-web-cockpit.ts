import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { execFile } from 'node:child_process';
import { GitService } from '@taskforge/workspace';
import { RunRepository, TaskForgeDatabase } from '@taskforge/persistence';
import { loadLivingPlan } from './living-plan.js';
import { addProjectMemoryEntry, loadProjectMemory } from './project-memory.js';
import { DirectTelemetryStore } from './direct-telemetry.js';
import { SpecialtyRouter } from './specialty-router.js';
import { ScheduleStore } from './daemon-scheduler.js';
import { loadMultiRepoWorkspace } from './multi-repo.js';

export interface LocalWebCockpitOptions {
  repoRoot: string;
  db: TaskForgeDatabase;
  gitService?: GitService;
  port?: number;
  host?: string;
  onAction?: (action: string, payload: Record<string, unknown>) => Promise<{ ok: boolean; message: string }>;
}

export interface ParsedDiffFile {
  file: string;
  additions: number;
  deletions: number;
  lines: string[];
}

export function parseUnifiedDiff(diffText: string): ParsedDiffFile[] {
  const files: ParsedDiffFile[] = [];
  let current: ParsedDiffFile | undefined;

  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      current = { file: m?.[2] ?? 'unknown', additions: 0, deletions: 0, lines: [line] };
      files.push(current);
      continue;
    }
    if (!current) continue;
    current.lines.push(line);
    if (line.startsWith('+') && !line.startsWith('+++')) current.additions += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) current.deletions += 1;
  }

  return files;
}

function listCouncilReports(repoRoot: string): Array<{ id: string; path: string; preview: string; content: string }> {
  const dir = path.join(repoRoot, '.taskforge', 'councils');
  if (!fs.existsSync(dir)) return [];
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .reverse()
      .slice(0, 12)
      .map((name) => {
        const full = path.join(dir, name);
        const content = fs.readFileSync(full, 'utf8');
        const firstLine = content.split('\n').find((l) => l.startsWith('> **Problem:**')) ?? name;
        return {
          id: name.replace(/\.md$/, ''),
          path: `.taskforge/councils/${name}`,
          preview: firstLine.replace(/^>\s*\*\*Problem:\*\*\s*/, '').slice(0, 120),
          content: content.slice(0, 12000),
        };
      });
  } catch {
    return [];
  }
}

/**
 * Zero-dependency, strictly localhost (`127.0.0.1`) Web Cockpit (`tf ui` / `/ui`).
 * Serves a live SSE-powered dashboard over TaskForge's SQLite DB, Living Plan,
 * Debate Council transcripts, Project Memory, Telemetry, and visual side-by-side
 * / unified diffs with 1-click Apply/Undo actions.
 */
export class LocalWebCockpitServer {
  private server?: http.Server;
  private readonly sseClients = new Set<http.ServerResponse>();
  private heartbeatTimer?: NodeJS.Timeout;
  private boundPort = 0;
  private readonly host: string;
  private readonly git: GitService;
  private readonly directTelemetry: DirectTelemetryStore;
  private readonly specialtyRouter: SpecialtyRouter;

  constructor(private readonly options: LocalWebCockpitOptions) {
    this.host = options.host ?? '127.0.0.1';
    this.git = options.gitService ?? new GitService(options.repoRoot);
    this.directTelemetry = new DirectTelemetryStore(options.db);
    this.specialtyRouter = new SpecialtyRouter(options.db, this.directTelemetry);
  }

  public get url(): string {
    return `http://${this.host}:${this.boundPort}`;
  }

  public get port(): number {
    return this.boundPort;
  }

  public async buildStateSnapshot(): Promise<Record<string, unknown>> {
    const status = await this.git.getStatus(this.options.repoRoot).catch(() => undefined);
    const diffRaw = await this.git.exec(['diff', 'HEAD'], this.options.repoRoot).catch(() => '');
    const runs = new RunRepository(this.options.db).listAll().slice(0, 15);
    const livingPlan = loadLivingPlan(this.options.repoRoot) ?? null;
    const memory = loadProjectMemory(this.options.repoRoot);
    const councils = listCouncilReports(this.options.repoRoot);
    const schedules = new ScheduleStore(this.options.repoRoot).list();
    const multiRepo = loadMultiRepoWorkspace(this.options.repoRoot) ?? null;

    return {
      repoName: path.basename(this.options.repoRoot),
      repoRoot: this.options.repoRoot,
      branch: status?.currentBranch ?? 'unknown',
      headCommit: status?.headCommit?.slice(0, 7) ?? '',
      isClean: status?.isClean ?? true,
      workingDiffFiles: parseUnifiedDiff(diffRaw).map((f) => ({
        file: f.file,
        additions: f.additions,
        deletions: f.deletions,
      })),
      runs,
      livingPlan,
      memory,
      councils,
      telemetry: {
        directSummaries: this.directTelemetry.getAgentSummaries(),
        specialties: this.specialtyRouter.computeSpecialtyMetrics().slice(0, 10),
      },
      schedules,
      multiRepo,
      updatedAt: new Date().toISOString(),
    };
  }

  public async start(): Promise<{ url: string; port: number }> {
    if (this.server) return { url: this.url, port: this.boundPort };

    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.options.port ?? 0, this.host, () => {
        const addr = this.server!.address();
        this.boundPort = typeof addr === 'object' && addr ? addr.port : (this.options.port ?? 4310);
        resolve();
      });
    });

    this.heartbeatTimer = setInterval(() => {
      void this.broadcastState();
    }, 3000);
    this.heartbeatTimer.unref();

    return { url: this.url, port: this.boundPort };
  }

  public async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    for (const client of this.sseClients) {
      client.end();
    }
    this.sseClients.clear();
    if (!this.server) return;
    const srv = this.server;
    this.server = undefined;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }

  public openInBrowser(): void {
    if (process.env.VITEST || !this.boundPort) return;
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', this.url] : [this.url];
    execFile(cmd, args, () => {});
  }

  private async broadcastState(): Promise<void> {
    if (this.sseClients.size === 0) return;
    const snap = await this.buildStateSnapshot().catch(() => undefined);
    if (!snap) return;
    const payload = `data: ${JSON.stringify(snap)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(payload);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const parsed = new URL(req.url || '/', `http://${this.host}:${this.boundPort || 80}`);

    if (req.method === 'GET' && parsed.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderCockpitHtml());
      return;
    }

    if (req.method === 'GET' && parsed.pathname === '/api/state') {
      const snap = await this.buildStateSnapshot();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(snap));
      return;
    }

    if (req.method === 'GET' && parsed.pathname === '/api/diff') {
      const diffRaw = await this.git.exec(['diff', 'HEAD'], this.options.repoRoot).catch(() => '');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ files: parseUnifiedDiff(diffRaw) }));
      return;
    }

    if (req.method === 'GET' && parsed.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      this.sseClients.add(res);
      const initial = await this.buildStateSnapshot();
      res.write(`data: ${JSON.stringify(initial)}\n\n`);
      req.on('close', () => {
        this.sseClients.delete(res);
      });
      return;
    }

    if (req.method === 'POST' && parsed.pathname === '/api/action') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      let body: { action?: string; payload?: Record<string, unknown> } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, message: 'Invalid JSON body' }));
        return;
      }

      if (body.action === 'memory_add' && typeof body.payload?.text === 'string' && body.payload.text.trim()) {
        const saved = addProjectMemoryEntry(this.options.repoRoot, body.payload.text.trim(), 'preference');
        void this.broadcastState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: `Saved memory #${saved.entry.id}` }));
        return;
      }

      if (this.options.onAction && typeof body.action === 'string') {
        const result = await this.options.onAction(body.action, body.payload ?? {});
        void this.broadcastState();
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: `Unsupported action: ${String(body.action)}` }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

function renderCockpitHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>TaskForge Local Cockpit</title>
<style>
  :root { --bg:#0d1117; --card:#161b22; --border:#30363d; --fg:#e6edf3; --dim:#8b949e; --accent:#58a6ff; --green:#3fb950; --red:#f85149; --yellow:#d29922; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:ui-sans-serif,system-ui,-apple-system,sans-serif; background:var(--bg); color:var(--fg); }
  header { display:flex; align-items:center; justify-content:space-between; padding:14px 20px; border-bottom:1px solid var(--border); background:var(--card); }
  header h1 { margin:0; font-size:16px; letter-spacing:.3px; }
  .badge { font-size:12px; padding:3px 8px; border-radius:999px; background:#1f2937; color:var(--accent); border:1px solid var(--border); }
  nav { display:flex; gap:8px; padding:10px 20px; border-bottom:1px solid var(--border); }
  nav button { background:transparent; color:var(--dim); border:1px solid var(--border); border-radius:6px; padding:6px 12px; cursor:pointer; font-size:13px; }
  nav button.active { background:var(--accent); color:#0d1117; border-color:var(--accent); font-weight:600; }
  main { padding:20px; max-width:1280px; margin:0 auto; display:grid; gap:16px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); gap:16px; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:16px; }
  .card h2 { margin:0 0 10px; font-size:14px; color:var(--accent); }
  pre { margin:0; overflow:auto; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; line-height:1.45; }
  .diff-add { background:rgba(63,185,80,.15); color:#aff5b4; display:block; }
  .diff-del { background:rgba(248,81,73,.15); color:#ffdcd7; display:block; }
  .diff-hunk { color:var(--accent); display:block; }
  .row { display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid #21262d; font-size:13px; }
  .muted { color:var(--dim); font-size:12px; }
  input { background:var(--bg); color:var(--fg); border:1px solid var(--border); border-radius:6px; padding:6px 10px; width:75%; }
  .btn { background:#238636; color:#fff; border:none; border-radius:6px; padding:6px 12px; cursor:pointer; font-size:12px; }
</style>
</head>
<body>
<header>
  <h1>✦ TaskForge Local Cockpit</h1>
  <div id="meta" class="badge">Connecting…</div>
</header>
<nav>
  <button class="active" onclick="setTab('overview', this)">Overview & Telemetry</button>
  <button onclick="setTab('diff', this)">Visual Diff</button>
  <button onclick="setTab('plan', this)">Living Plan & Waves</button>
  <button onclick="setTab('councils', this)">Debate Councils</button>
  <button onclick="setTab('memory', this)">Project Memory & Schedules</button>
</nav>
<main id="app"><div class="card">Loading local state…</div></main>
<script>
let state = null, diffData = null, tab = 'overview';
function setTab(t, el){ tab = t; document.querySelectorAll('nav button').forEach(b=>b.classList.remove('active')); el.classList.add('active'); if(t==='diff') fetchDiff(); render(); }
async function fetchDiff(){ const r = await fetch('/api/diff'); diffData = await r.json(); render(); }
async function addMemory(){ const inp = document.getElementById('mem-input'); if(!inp||!inp.value.trim()) return; await fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'memory_add',payload:{text:inp.value.trim()}})}); inp.value=''; }
function esc(s){ return String(s||'').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
function render(){
  if(!state) return;
  document.getElementById('meta').textContent = state.repoName + ' · ' + state.branch + ' (' + state.headCommit + ')';
  const app = document.getElementById('app');
  if(tab==='overview'){
    const runs = (state.runs||[]).map(r=>'<div class="row"><span>'+esc(r.id)+'</span><span class="muted">'+esc(r.status)+'</span></div>').join('') || '<div class="muted">No orchestrated runs yet.</div>';
    const agents = (state.telemetry?.directSummaries||[]).map(a=>'<div class="row"><span>'+esc(a.agentName)+'</span><span>'+a.turns+' turns · '+Math.round(a.successRate*100)+'% ok · ~$'+a.totalCostUsd+'</span></div>').join('') || '<div class="muted">No direct turns recorded yet.</div>';
    const specs = (state.telemetry?.specialties||[]).map(s=>'<div class="row"><span>'+esc(s.specialty)+' → <b>'+esc(s.agentId)+'</b></span><span class="muted">'+Math.round(s.successRate*100)+'% (n='+s.samples+')</span></div>').join('') || '<div class="muted">Learning from runs…</div>';
    app.innerHTML = '<div class="grid"><div class="card"><h2>Recent Runs</h2>'+runs+'</div><div class="card"><h2>Direct & Council Telemetry</h2>'+agents+'</div><div class="card"><h2>Learned Specialties</h2>'+specs+'</div></div>';
  } else if(tab==='diff'){
    const files = (diffData?.files||[]);
    if(!files.length){ app.innerHTML = '<div class="card"><h2>Working Tree Diff</h2><div class="muted">Working tree is clean.</div></div>'; return; }
    app.innerHTML = files.map(f=>{
      const body = f.lines.map(l=> l.startsWith('+')&&!l.startsWith('+++') ? '<span class="diff-add">'+esc(l)+'</span>' : l.startsWith('-')&&!l.startsWith('---') ? '<span class="diff-del">'+esc(l)+'</span>' : l.startsWith('@@') ? '<span class="diff-hunk">'+esc(l)+'</span>' : '<span>'+esc(l)+'</span>\\n').join('');
      return '<div class="card"><h2>'+esc(f.file)+' <span class="muted">(+'+f.additions+' / -'+f.deletions+')</span></h2><pre>'+body+'</pre></div>';
    }).join('');
  } else if(tab==='plan'){
    if(!state.livingPlan){ app.innerHTML = '<div class="card"><h2>Living Plan</h2><div class="muted">No .taskforge/plan.md yet. Run /blueprint in tf.</div></div>'; return; }
    const waves = state.livingPlan.waves.map(w=>'<div class="row"><span><b>Wave '+w.number+': '+esc(w.name)+'</b> ('+w.mode+')</span><span>'+esc(w.status)+'</span></div>').join('');
    app.innerHTML = '<div class="card"><h2>'+esc(state.livingPlan.title)+'</h2><p class="muted">'+esc(state.livingPlan.goal)+'</p>'+waves+'</div>';
  } else if(tab==='councils'){
    const cs = (state.councils||[]);
    if(!cs.length){ app.innerHTML = '<div class="card"><h2>Debate Councils</h2><div class="muted">No saved council transcripts yet. Run /council in tf.</div></div>'; return; }
    app.innerHTML = cs.map(c=>'<div class="card"><h2>'+esc(c.id)+' — '+esc(c.preview)+'</h2><pre>'+esc(c.content)+'</pre></div>').join('');
  } else {
    const mem = (state.memory||[]).map(m=>'<div class="row"><span>#'+m.id+' ['+esc(m.category)+'] '+esc(m.text)+'</span></div>').join('') || '<div class="muted">Empty memory.</div>';
    const sch = (state.schedules||[]).map(s=>'<div class="row"><span>'+esc(s.id)+' ('+esc(s.schedule)+')</span><span class="muted">'+esc(s.command)+'</span></div>').join('') || '<div class="muted">No scheduled automations.</div>';
    app.innerHTML = '<div class="grid"><div class="card"><h2>Project Memory (.taskforge/memory.md)</h2>'+mem+'<div style="margin-top:12px"><input id="mem-input" placeholder="Add durable rule..." /> <button class="btn" onclick="addMemory()">Add</button></div></div><div class="card"><h2>Scheduled Automations</h2>'+sch+'</div></div>';
  }
}
const es = new EventSource('/api/events');
es.onmessage = (ev) => { state = JSON.parse(ev.data); render(); };
</script>
</body>
</html>`;
}
