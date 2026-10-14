'use strict';

const $ = (sel) => document.querySelector(sel);

// ─── Tab switching ────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    $(`#tab-${tab.dataset.tab}`).classList.add('active');
    if (tab.dataset.tab === 'tag') loadFiles();
    if (tab.dataset.tab === 'convert') refreshSpotifyStatus();
    if (tab.dataset.tab === 'retag') loadRetagFiles();
    if (tab.dataset.tab === 'review') loadReview();
  });
});

// ─── Header: config + dependency health ─────────────────────────────────────
async function loadHeader() {
  try {
    const cfg = await (await fetch('/api/config')).json();
    $('#meta-folder').textContent = `Folder: ${cfg.folder}`;
    $('#meta-provider').textContent = `Provider: ${cfg.provider}`;
  } catch { /* ignore */ }

  try {
    const health = await (await fetch('/api/health')).json();
    const el = $('#meta-health');
    if (health.ytDlp.ok && health.ffmpeg.ok) {
      el.textContent = `yt-dlp ${health.ytDlp.version} · ffmpeg ✓`;
      el.className = 'health ok';
    } else {
      const missing = [];
      if (!health.ytDlp.ok) missing.push('yt-dlp');
      if (!health.ffmpeg.ok) missing.push('ffmpeg');
      el.textContent = `Missing: ${missing.join(', ')} (install + add to PATH)`;
      el.className = 'health bad';
    }
  } catch {
    $('#meta-health').textContent = 'Could not check dependencies';
    $('#meta-health').className = 'health bad';
  }
}

// ─── Generic SSE helper ─────────────────────────────────────────────────────
function streamSse(url, onEvent, onClose) {
  const es = new EventSource(url);
  es.onmessage = (e) => {
    try { onEvent(JSON.parse(e.data)); } catch { /* ignore */ }
  };
  es.onerror = () => { es.close(); if (onClose) onClose(); };
  return es;
}

// ─── Cancellation ────────────────────────────────────────────────────────────
// One operation runs at a time; cancelling aborts all server jobs and closes
// the active client stream.
let activeStream = null; // { close: fn }

async function cancelActive() {
  try { await fetch('/api/cancel', { method: 'POST' }); } catch { /* ignore */ }
  if (activeStream) { try { activeStream.close(); } catch { /* ignore */ } activeStream = null; }
}

[['download-cancel'], ['tag-cancel'], ['convert-cancel'], ['retag-cancel']].forEach(([id]) => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', cancelActive);
});

function setRunning(cancelId, running) {
  const el = document.getElementById(cancelId);
  if (el) el.disabled = !running;
}

// SSE-over-POST (EventSource is GET-only; we need to send a selection body).
async function streamPost(url, body, onEvent, onClose, signal) {
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const part of parts) {
        const line = part.split('\n').find((l) => l.startsWith('data: '));
        if (line) { try { onEvent(JSON.parse(line.slice(6))); } catch { /* ignore */ } }
      }
    }
  } catch (e) {
    if (!(signal && signal.aborted)) onEvent({ type: 'error', message: String(e) });
  } finally {
    if (onClose) onClose();
  }
}

// ─── Log helpers ────────────────────────────────────────────────────────────
function appendLog(pre, text, cls) {
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text + '\n';
  pre.appendChild(span);
  pre.scrollTop = pre.scrollHeight;
}

// ─── Download tab ───────────────────────────────────────────────────────────
const downloadBtn = $('#download-btn');
downloadBtn.addEventListener('click', () => {
  const url = $('#url').value.trim();
  if (!url) { $('#url').focus(); return; }

  const playlist = $('#playlist').checked;
  const overwrite = false;
  const quality = $('#quality').value;
  const log = $('#download-log');
  const bar = $('#download-bar');
  const progress = $('#download-progress');

  log.textContent = '';
  bar.style.width = '0%';
  progress.classList.remove('hidden');
  downloadBtn.disabled = true;
  downloadBtn.textContent = 'Downloading…';

  const qs = new URLSearchParams({ url, playlist: String(playlist), quality, overwrite: String(overwrite) });
  let es;

  const finish = () => {
    downloadBtn.disabled = false;
    downloadBtn.textContent = 'Download';
    setRunning('download-cancel', false);
    activeStream = null;
  };

  setRunning('download-cancel', true);

  es = streamSse(`/api/download?${qs.toString()}`, (ev) => {
    switch (ev.type) {
      case 'log':
        appendLog(log, ev.line,
          /error|unable|warning/i.test(ev.line) ? 'line-warn' : null);
        if (/access is denied|winerror 5/i.test(ev.line)) {
          appendLog(log,
            '  ↳ A file with this name already exists and is locked. Tick "Overwrite existing", ' +
            'and if it persists, close any music player using the file or allow ffmpeg/yt-dlp in ' +
            'Windows "Controlled folder access" / antivirus.',
            'line-warn');
        }
        break;
      case 'progress':
        bar.style.width = `${ev.percent}%`;
        break;
      case 'item-done':
        appendLog(log, `✓ Saved: ${ev.file}`, 'line-ok');
        break;
      case 'error':
        appendLog(log, `✗ ${ev.message}`, 'line-error');
        break;
      case 'cancelled':
        appendLog(log, `\n⛔ Cancelled.`, 'line-warn');
        break;
      case 'done':
        bar.style.width = '100%';
        appendLog(log, `\nFinished (exit code ${ev.code}).`, 'line-ok');
        es.close();
        finish();
        break;
    }
  }, finish);
  activeStream = { close: () => es.close() };
});

// ─── Tag tab ────────────────────────────────────────────────────────────────
const fileListEl = $('#file-list');
const fileNodes = new Map();

async function loadFiles() {
  try {
    const { files } = await (await fetch('/api/files')).json();
    // Normalize: server returns [{name, tagged}]
    const all = files.map((f) => (typeof f === 'string' ? { name: f, tagged: false } : f));
    const showTagged = $('#show-tagged').checked;
    const visible = showTagged ? all : all.filter((f) => !f.tagged);
    const hiddenCount = all.length - visible.length;

    fileListEl.innerHTML = '';
    fileNodes.clear();
    visible.forEach((f) => {
      const li = document.createElement('li');
      li.innerHTML =
        `<span class="status">•</span><span class="name"></span><span class="detail"></span>`;
      li.querySelector('.name').textContent = f.name;
      if (f.tagged) { li.classList.add('success'); li.querySelector('.status').textContent = '✓'; li.querySelector('.detail').textContent = 'already tagged'; }
      fileListEl.appendChild(li);
      fileNodes.set(f.name, li);
    });

    let msg = `${visible.length} file(s)`;
    if (hiddenCount > 0) msg += ` · ${hiddenCount} already tagged (hidden)`;
    $('#tag-count').textContent = msg;
  } catch (err) {
    $('#tag-count').textContent = 'Error loading files';
  }
}

document.getElementById('show-tagged').addEventListener('change', loadFiles);

function setFileState(name, state, statusChar, detail) {
  const li = fileNodes.get(name);
  if (!li) return;
  li.className = state;
  li.querySelector('.status').textContent = statusChar;
  if (detail !== undefined) li.querySelector('.detail').textContent = detail;
}

// Console toggle + clear
const tagLog = $('#tag-log');
const tagLayout = document.querySelector('.tag-layout');
$('#show-console').addEventListener('change', (e) => {
  tagLayout.classList.toggle('no-console', !e.target.checked);
});
$('#clear-console').addEventListener('click', () => { tagLog.textContent = ''; });

function classForDebug(msg) {
  if (msg.includes('✓')) return 'line-ok';
  if (msg.includes('✗')) return 'line-error';
  if (msg.includes('⚠')) return 'line-warn';
  if (msg.startsWith('raw filename:')) return 'line-head';
  return 'line-dim';
}

const tagBtn = $('#tag-btn');
tagBtn.addEventListener('click', async () => {
  await loadFiles();
  if (fileNodes.size === 0) { $('#tag-count').textContent = 'No files to tag'; return; }

  const bar = $('#tag-bar');
  const progress = $('#tag-progress');
  bar.style.width = '0%';
  progress.classList.remove('hidden');
  tagLog.textContent = '';
  tagBtn.disabled = true;
  tagBtn.textContent = 'Tagging…';

  let total = fileNodes.size;
  let processed = 0;

  const finish = () => {
    tagBtn.disabled = false;
    tagBtn.textContent = 'Tag untagged files';
    setRunning('tag-cancel', false);
    activeStream = null;
  };

  setRunning('tag-cancel', true);
  const all = $('#show-tagged').checked ? 'true' : 'false';
  const es = streamSse(`/api/tag?all=${all}`, (ev) => {
    switch (ev.type) {
      case 'start':
        total = ev.total || total;
        break;
      case 'file-start':
        setFileState(ev.filename, 'working', '⟳');
        appendLog(tagLog, `\n▶ ${ev.filename}`, 'line-head');
        break;
      case 'debug':
        appendLog(tagLog, ev.message, classForDebug(ev.message));
        break;
      case 'success':
        processed++;
        setFileState(ev.filename, 'success', '✓',
          `${ev.metadata.artist} — ${ev.metadata.album || ''}` +
          (ev.metadata.confidence != null ? ` (score ${ev.metadata.confidence})` : ''));
        bar.style.width = `${(processed / total) * 100}%`;
        break;
      case 'no-match':
        processed++;
        setFileState(ev.filename, 'nomatch', '?', 'no match found');
        bar.style.width = `${(processed / total) * 100}%`;
        break;
      case 'error':
        processed++;
        setFileState(ev.filename, 'error', '✗', ev.error);
        appendLog(tagLog, `✗ ERROR: ${ev.error}`, 'line-error');
        bar.style.width = `${(processed / total) * 100}%`;
        break;
      case 'cancelled':
        appendLog(tagLog, `\n⛔ Cancelled.`, 'line-warn');
        break;
      case 'done':
        bar.style.width = '100%';
        $('#tag-count').textContent =
          `Done — ${ev.results.filter((r) => r.success).length}/${ev.results.length} tagged`;
        es.close();
        finish();
        break;
    }
  }, finish);
  activeStream = { close: () => es.close() };
});

$('#refresh-btn').addEventListener('click', loadFiles);

// ─── Convert tab (Spotify → MP3) ────────────────────────────────────────────
const convLog = $('#convert-log');
const convList = $('#convert-list');
const convNodes = new Map();

async function refreshSpotifyStatus() {
  try {
    const { connected } = await (await fetch('/api/spotify/status')).json();
    const status = $('#spotify-status');
    if (connected) {
      status.textContent = 'Spotify: connected ✓';
      status.className = 'health ok';
      $('#spotify-connect').classList.add('hidden');
      $('#spotify-logout').classList.remove('hidden');
    } else {
      status.textContent = 'Spotify: not connected';
      status.className = 'health bad';
      $('#spotify-connect').classList.remove('hidden');
      $('#spotify-logout').classList.add('hidden');
    }
  } catch {
    $('#spotify-status').textContent = 'Spotify: status unavailable';
  }
}

$('#spotify-connect').addEventListener('click', () => {
  // Open Spotify's consent screen; the callback stores the token, then we re-check.
  const w = window.open('/api/spotify/login', 'spotify-auth', 'width=520,height=720');
  const timer = setInterval(async () => {
    if (w && w.closed) { clearInterval(timer); refreshSpotifyStatus(); }
  }, 1000);
});

$('#spotify-logout').addEventListener('click', async () => {
  await fetch('/api/spotify/logout', { method: 'POST' });
  refreshSpotifyStatus();
});

$('#load-playlists-btn').addEventListener('click', async () => {
  const picker = $('#playlist-picker');
  if (!picker.classList.contains('hidden')) { picker.classList.add('hidden'); return; }
  picker.innerHTML = '<option>Loading…</option>';
  picker.classList.remove('hidden');
  const showMsg = (msg) => {
    const o = document.createElement('option');
    o.value = '';
    o.disabled = true;
    o.textContent = msg;
    picker.innerHTML = '';
    picker.appendChild(o);
  };

  try {
    const resp = await fetch('/api/spotify/playlists');
    const data = await resp.json();
    if (!resp.ok || data.error) { showMsg(data.error || 'Failed to load playlists'); return; }
    if (!data.playlists || data.playlists.length === 0) { showMsg('No playlists found'); return; }
    picker.innerHTML = '';
    data.playlists.forEach((pl) => {
      const opt = document.createElement('option');
      opt.value = pl.id;
      opt.textContent = pl.trackCount ? `${pl.name} (${pl.trackCount})` : pl.name;
      picker.appendChild(opt);
    });
  } catch (e) {
    showMsg('Failed to load — connect Spotify first');
  }
});

$('#playlist-picker').addEventListener('change', (e) => {
  if (!e.target.value) return; // ignore disabled/message rows
  $('#playlist-input').value = e.target.value;
  e.target.classList.add('hidden');
});

$('#clear-convert-console').addEventListener('click', () => { convLog.textContent = ''; });

function ensureConvNode(label) {
  let li = convNodes.get(label);
  if (!li) {
    li = document.createElement('li');
    li.innerHTML = `<span class="status">•</span><span class="name"></span><span class="detail"></span>`;
    li.querySelector('.name').textContent = label;
    convList.appendChild(li);
    convNodes.set(label, li);
  }
  return li;
}
function setConvState(label, state, ch, detail) {
  const li = ensureConvNode(label);
  li.className = state;
  li.querySelector('.status').textContent = ch;
  if (detail !== undefined) li.querySelector('.detail').textContent = detail;
}

const convertBtn = $('#convert-btn');
convertBtn.addEventListener('click', () => {
  const playlist = $('#playlist-input').value.trim();
  if (!playlist) { $('#playlist-input').focus(); return; }

  const quality = $('#convert-quality').value;
  const bar = $('#convert-bar');
  $('#convert-progress').classList.remove('hidden');
  bar.style.width = '0%';
  convLog.textContent = '';
  convList.innerHTML = '';
  convNodes.clear();
  $('#convert-summary').textContent = '';
  convertBtn.disabled = true;
  convertBtn.textContent = 'Converting…';

  let total = 0, processed = 0;
  const finish = () => {
    convertBtn.disabled = false;
    convertBtn.textContent = 'Convert';
    setRunning('convert-cancel', false);
    activeStream = null;
  };

  setRunning('convert-cancel', true);
  const qs = new URLSearchParams({ playlist, quality });
  const es = streamSse(`/api/convert?${qs.toString()}`, (ev) => {
    switch (ev.type) {
      case 'playlist':
        total = ev.total;
        $('#convert-summary').textContent = `Playlist "${ev.name}" — ${ev.total} tracks`;
        appendLog(convLog, `Playlist: ${ev.name} (${ev.total} tracks)\n`, 'line-head');
        break;
      case 'track-start':
        setConvState(`${ev.artist} - ${ev.track}`, 'working', '⟳', 'searching…');
        appendLog(convLog, `\n▶ ${ev.artist} - ${ev.track}`, 'line-head');
        break;
      case 'debug':
        appendLog(convLog, ev.message, classForDebug(ev.message));
        break;
      case 'matched':
        setConvState(ev.track, 'working', '⟳', `↳ ${ev.videoTitle} — ${ev.channel}`);
        break;
      case 'track-done':
        processed++;
        setConvState(ev.track, 'success', '✓', ev.file);
        bar.style.width = `${(processed / total) * 100}%`;
        break;
      case 'track-skip':
        processed++;
        setConvState(ev.track, 'nomatch', '?', ev.reason);
        appendLog(convLog, `? skipped: ${ev.reason}`, 'line-warn');
        bar.style.width = `${(processed / total) * 100}%`;
        break;
      case 'track-exists':
        processed++;
        setConvState(ev.track, 'success', '⏭', `already downloaded (${ev.file})`);
        appendLog(convLog, `⏭ already downloaded: ${ev.file}`, 'line-dim');
        bar.style.width = `${(processed / total) * 100}%`;
        break;
      case 'track-error':
        processed++;
        setConvState(ev.track, 'error', '✗', ev.error);
        appendLog(convLog, `✗ ${ev.error}`, 'line-error');
        bar.style.width = `${(processed / total) * 100}%`;
        break;
      case 'playlist-file':
        appendLog(convLog, `\n📃 wrote playlist: ${ev.file}`, 'line-ok');
        break;
      case 'cancelled':
        appendLog(convLog, `\n⛔ Cancelled.`, 'line-warn');
        break;
      case 'done':
        bar.style.width = '100%';
        $('#convert-summary').textContent =
          `Done — ${ev.ok} downloaded, ${ev.exists || 0} already had, ${ev.skipped} skipped, ${ev.failed} failed (of ${ev.total})`;
        es.close();
        finish();
        break;
      case 'error':
        appendLog(convLog, `✗ ${ev.message}`, 'line-error');
        es.close();
        finish();
        break;
    }
  }, finish);
  activeStream = { close: () => es.close() };
});

// ─── Retag tab (fix mistakes) ───────────────────────────────────────────────
const retagListEl = $('#retag-list');
const retagLog = $('#retag-log');
const retagRows = new Map(); // filename -> { row, checkbox, input, detail, match }
let retagAll = [];

function stripExt(name) { return name.replace(/\.mp3$/i, ''); }

function renderRetag() {
  const filter = $('#retag-filter').value.trim().toLowerCase();
  retagListEl.innerHTML = '';
  retagRows.clear();
  let shown = 0;

  retagAll.forEach((f) => {
    const hay = `${f.name} ${f.artist} ${f.title} ${f.album}`.toLowerCase();
    if (filter && !hay.includes(filter)) return;
    shown++;

    const row = document.createElement('div');
    row.className = 'retag-row';
    const current = (f.artist || f.title)
      ? `${f.artist || '?'} — ${f.title || '?'}${f.album ? ` [${f.album}]` : ''}${f.trackNumber ? ` #${f.trackNumber}` : ''}`
      : '(untagged)';
    row.innerHTML =
      `<input type="checkbox" class="rt-check" />
       <div class="rt-main">
         <input type="text" class="rt-query" />
         <div class="rt-current"></div>
         <select class="rt-match hidden"></select>
       </div>
       <span class="status rt-status"></span>`;
    const checkbox = row.querySelector('.rt-check');
    const input = row.querySelector('.rt-query');
    const detail = row.querySelector('.rt-current');
    const match = row.querySelector('.rt-match');
    input.value = stripExt(f.name);
    detail.textContent = `now: ${current}`;
    match.addEventListener('change', () => {
      const selected = retagRows.get(f.name)?.candidates?.[Number(match.value)];
      if (selected) detail.textContent = `match: ${retagCandidateLabel(selected)}`;
    });
    if (!f.tagged) row.classList.add('nomatch');
    retagListEl.appendChild(row);
    retagRows.set(f.name, { row, checkbox, input, detail, match, candidates: [] });
  });

  $('#retag-count').textContent = `${shown} shown · ${retagAll.length} total`;
}

async function loadRetagFiles() {
  try {
    const { files } = await (await fetch('/api/files')).json();
    retagAll = files.map((f) => (typeof f === 'string' ? { name: f } : f));
    renderRetag();
  } catch {
    $('#retag-count').textContent = 'Error loading files';
  }
}

$('#retag-filter').addEventListener('input', renderRetag);
$('#retag-refresh').addEventListener('click', loadRetagFiles);
$('#retag-clear-console').addEventListener('click', () => { retagLog.textContent = ''; });
$('#retag-selectall').addEventListener('click', () => {
  retagRows.forEach((r) => { r.checkbox.checked = true; });
});
$('#retag-clear').addEventListener('click', () => {
  retagRows.forEach((r) => { r.checkbox.checked = false; });
});

function retagCandidateLabel(c) {
  return `${c.title} — ${c.artist} [${c.album}]` +
    `${c.trackNumber ? ` #${c.trackNumber}` : ''}` +
    ` · score ${c.score}`;
}

async function loadRetagCandidatesFor(name, r) {
  r.match.classList.remove('hidden');
  r.match.innerHTML = '<option>Loading matches...</option>';
  r.match.disabled = true;
  r.candidates = [];

  try {
    const resp = await fetch('/api/retag/candidates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: name, query: r.input.value }),
    });
    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(data.error || 'Could not load matches');

    r.candidates = data.candidates || [];
    r.match.innerHTML = '';
    if (r.candidates.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No Spotify matches';
      r.match.appendChild(opt);
      return;
    }

    r.candidates.forEach((candidate, index) => {
      const opt = document.createElement('option');
      opt.value = String(index);
      opt.textContent = retagCandidateLabel(candidate);
      r.match.appendChild(opt);
    });
    r.match.disabled = false;
    r.detail.textContent = `match: ${retagCandidateLabel(r.candidates[0])}`;
  } catch (err) {
    r.match.innerHTML = '';
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = err instanceof Error ? err.message : String(err);
    r.match.appendChild(opt);
  }
}

$('#retag-find').addEventListener('click', async () => {
  const selected = [];
  retagRows.forEach((r, name) => {
    if (r.checkbox.checked) selected.push([name, r]);
  });
  if (selected.length === 0) { $('#retag-count').textContent = 'Select at least one song'; return; }

  $('#retag-find').disabled = true;
  $('#retag-find').textContent = 'Finding...';
  $('#retag-count').textContent = `Finding matches for ${selected.length} song(s)...`;
  for (const [name, r] of selected) {
    await loadRetagCandidatesFor(name, r);
  }
  $('#retag-find').disabled = false;
  $('#retag-find').textContent = 'Find matches';
  $('#retag-count').textContent = `Loaded matches for ${selected.length} song(s)`;
});

const retagBtn = $('#retag-btn');
retagBtn.addEventListener('click', async () => {
  const items = [];
  retagRows.forEach((r, name) => {
    if (!r.checkbox.checked) return;
    const selected = r.candidates?.[Number(r.match.value)];
    items.push({ file: name, query: r.input.value, selected });
  });
  if (items.length === 0) { $('#retag-count').textContent = 'Select at least one song'; return; }

  const bar = $('#retag-bar');
  $('#retag-progress').classList.remove('hidden');
  bar.style.width = '0%';
  retagLog.textContent = '';
  retagBtn.disabled = true;
  retagBtn.textContent = 'Retagging…';

  let total = items.length, processed = 0;
  const setStatus = (name, cls, ch) => {
    const r = retagRows.get(name);
    if (r) { r.row.className = `retag-row ${cls}`; r.row.querySelector('.rt-status').textContent = ch; }
  };
  const controller = new AbortController();
  activeStream = { close: () => controller.abort() };
  setRunning('retag-cancel', true);
  const finish = () => {
    retagBtn.disabled = false;
    retagBtn.textContent = 'Retag selected';
    setRunning('retag-cancel', false);
    activeStream = null;
  };

  await streamPost('/api/retag', { items }, (ev) => {
    switch (ev.type) {
      case 'start': total = ev.total || total; break;
      case 'file-start': setStatus(ev.filename, 'working', '⟳'); appendLog(retagLog, `\n▶ ${ev.filename}`, 'line-head'); break;
      case 'debug': appendLog(retagLog, ev.message, classForDebug(ev.message)); break;
      case 'success':
        processed++;
        setStatus(ev.filename, 'success', '✓');
        { const r = retagRows.get(ev.filename); if (r) r.detail.textContent = `now: ${ev.metadata.artist} — ${ev.metadata.title}${ev.metadata.album ? ` [${ev.metadata.album}]` : ''}${ev.metadata.trackNumber ? ` #${ev.metadata.trackNumber}` : ''}`; }
        bar.style.width = `${(processed / total) * 100}%`;
        break;
      case 'no-match':
        processed++; setStatus(ev.filename, 'nomatch', '?');
        appendLog(retagLog, `? no match for ${ev.filename}`, 'line-warn');
        bar.style.width = `${(processed / total) * 100}%`;
        break;
      case 'error':
        processed++; setStatus(ev.filename, 'error', '✗');
        appendLog(retagLog, `✗ ${ev.filename}: ${ev.error || ev.message}`, 'line-error');
        bar.style.width = `${(processed / total) * 100}%`;
        break;
      case 'cancelled':
        appendLog(retagLog, `\n⛔ Cancelled.`, 'line-warn');
        break;
      case 'done':
        bar.style.width = '100%';
        $('#retag-count').textContent = `Done — retagged ${ev.results ? ev.results.filter((x) => x.success).length : processed}/${total}`;
        break;
    }
  }, finish, controller.signal);
});

// ─── Review tab (low-confidence tags) ───────────────────────────────────────
const reviewListEl = $('#review-list');
let reviewItems = [];
let reviewSelected = new Set(); // filenames

function scoreBadge(score) {
  if (score === undefined || score === null) return '<span class="score-badge score-none">? no score</span>';
  if (score >= 80) return `<span class="score-badge score-ok">✓ ${score}</span>`;
  if (score >= 60) return `<span class="score-badge score-low">⚠ ${score}</span>`;
  return `<span class="score-badge score-bad">✗ ${score}</span>`;
}

function renderReview() {
  reviewListEl.innerHTML = '';
  reviewSelected.clear();

  if (reviewItems.length === 0) {
    reviewListEl.innerHTML = '<p style="color:var(--muted);padding:12px 0">No low-confidence tags found — everything looks good!</p>';
    $('#review-count').textContent = '';
    $('#review-retag-btn').disabled = true;
    return;
  }

  reviewItems.forEach((f) => {
    const row = document.createElement('div');
    row.className = 'review-row';
    const tagLine = (f.artist || f.title)
      ? `${f.artist || '?'} — ${f.title || '?'}${f.album ? ` · ${f.album}` : ''}`
      : '(no tags read)';
    row.innerHTML =
      `<input type="checkbox" class="rv-check" />
       <div class="rv-info">
         <div class="rv-title">${f.name}</div>
         <div class="rv-sub">${tagLine}</div>
       </div>
       ${scoreBadge(f.score)}`;

    const cb = row.querySelector('.rv-check');
    row.addEventListener('click', (e) => {
      if (e.target !== cb) cb.checked = !cb.checked;
      if (cb.checked) { reviewSelected.add(f.name); row.classList.add('selected'); }
      else { reviewSelected.delete(f.name); row.classList.remove('selected'); }
      $('#review-retag-btn').disabled = reviewSelected.size === 0;
    });
    reviewListEl.appendChild(row);
  });

  $('#review-count').textContent = `${reviewItems.length} file(s) need review`;
  $('#review-retag-btn').disabled = true;
}

async function loadReview() {
  $('#review-count').textContent = 'Loading…';
  reviewListEl.innerHTML = '';
  try {
    const data = await (await fetch('/api/review')).json();
    reviewItems = data.items || [];
    renderReview();
  } catch {
    $('#review-count').textContent = 'Error loading review list';
  }
}

$('#review-refresh').addEventListener('click', loadReview);

$('#review-retag-btn').addEventListener('click', () => {
  if (reviewSelected.size === 0) return;

  // Switch to Retag tab and pre-filter to selected files
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
  document.querySelector('[data-tab="retag"]').classList.add('active');
  $('#tab-retag').classList.add('active');

  // Load retag files then select + filter the chosen ones
  loadRetagFiles().then(() => {
    const names = reviewSelected;
    // Check matching rows
    retagRows.forEach((r, name) => {
      if (names.has(name)) r.checkbox.checked = true;
    });
    // Set filter to show all (clear any existing filter)
    $('#retag-filter').value = '';
    renderRetag();
    // Re-check after re-render
    retagRows.forEach((r, name) => {
      if (names.has(name)) {
        r.checkbox.checked = true;
        r.row.classList.add('selected');
      }
    });
    $('#retag-count').textContent = `${names.size} file(s) pre-selected from Review`;
  });
});

// ─── Init ───────────────────────────────────────────────────────────────────
loadHeader();
