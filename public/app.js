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

[['download-cancel'], ['tag-cancel'], ['convert-cancel'], ['album-cancel'], ['song-cancel'], ['retag-cancel']].forEach(([id]) => {
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
  const downloaded = []; // filenames saved this run, for auto-tagging

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
        downloaded.push(ev.file);
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
        // Auto-tag the files we just downloaded (uses the configured provider).
        if ($('#auto-tag').checked && downloaded.length > 0) {
          autoTagDownloaded(downloaded, log, bar, finish);
        } else {
          finish();
        }
        break;
    }
  }, finish);
  activeStream = { close: () => { es.close(); appendLog(log, '\n⛔ Cancelled.', 'line-warn'); finish(); } };
});

/** Chain tagging onto a finished download, streaming results into the same log. */
function autoTagDownloaded(files, log, bar, done) {
  appendLog(log, `\n🏷 Auto-tagging ${files.length} file(s)…`, 'line-head');
  bar.style.width = '0%';
  downloadBtn.textContent = 'Tagging…';
  let total = files.length, processed = 0;
  const qs = new URLSearchParams({ files: files.join('\n') });
  const es = streamSse(`/api/tag-files?${qs.toString()}`, (ev) => {
    switch (ev.type) {
      case 'start':
        total = ev.total || total;
        break;
      case 'file-start':
        appendLog(log, `\n▶ ${ev.filename}`, 'line-head');
        break;
      case 'debug':
        appendLog(log, ev.message, classForDebug(ev.message));
        break;
      case 'success':
        processed++;
        appendLog(log,
          `✓ ${ev.metadata.artist} — ${ev.metadata.title}` +
          `${ev.metadata.album ? ` [${ev.metadata.album}]` : ''}` +
          `${ev.metadata.trackNumber ? ` #${ev.metadata.trackNumber}` : ''}`,
          'line-ok');
        bar.style.width = `${(processed / total) * 100}%`;
        break;
      case 'no-match':
        processed++;
        appendLog(log, `? no match: ${ev.filename}`, 'line-warn');
        bar.style.width = `${(processed / total) * 100}%`;
        break;
      case 'error':
        processed++;
        appendLog(log, `✗ ${ev.filename}: ${ev.error}`, 'line-error');
        bar.style.width = `${(processed / total) * 100}%`;
        break;
      case 'cancelled':
        appendLog(log, `\n⛔ Cancelled.`, 'line-warn');
        break;
      case 'done':
        bar.style.width = '100%';
        appendLog(log,
          `\n🏷 Auto-tag complete — ${ev.results.filter((r) => r.success).length}/${ev.results.length} tagged.`,
          'line-ok');
        es.close();
        done();
        break;
    }
  }, done);
  activeStream = { close: () => { es.close(); appendLog(log, '\n⛔ Cancelled.', 'line-warn'); done(); } };
}

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
  activeStream = { close: () => { es.close(); appendLog(tagLog, '\n⛔ Cancelled.', 'line-warn'); finish(); } };
});

$('#refresh-btn').addEventListener('click', loadFiles);

// ─── Convert tab (Spotify → MP3) ────────────────────────────────────────────
const convLog = $('#convert-log');

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

// Shared converter stream runner — both the Convert (playlist) and Albums tabs
// stream the identical ConvertEvent protocol, so they share this renderer.
function makeConvertRunner(els) {
  const nodes = new Map();
  const ensureNode = (label) => {
    let li = nodes.get(label);
    if (!li) {
      li = document.createElement('li');
      li.innerHTML = `<span class="status">•</span><span class="name"></span><span class="detail"></span>`;
      li.querySelector('.name').textContent = label;
      els.list.appendChild(li);
      nodes.set(label, li);
    }
    return li;
  };
  const setState = (label, state, ch, detail) => {
    const li = ensureNode(label);
    li.className = state;
    li.querySelector('.status').textContent = ch;
    if (detail !== undefined) li.querySelector('.detail').textContent = detail;
  };

  return function start(streamUrl) {
    els.progress.classList.remove('hidden');
    els.bar.style.width = '0%';
    els.log.textContent = '';
    els.list.innerHTML = '';
    nodes.clear();
    els.summary.textContent = '';
    els.btn.disabled = true;
    els.btn.textContent = 'Converting…';

    let total = 0, processed = 0;
    const finish = () => {
      els.btn.disabled = false;
      els.btn.textContent = els.btnLabel;
      setRunning(els.cancelId, false);
      activeStream = null;
    };
    setRunning(els.cancelId, true);

    const es = streamSse(streamUrl, (ev) => {
      switch (ev.type) {
        case 'playlist':
          total = ev.total;
          els.summary.textContent = `"${ev.name}" — ${ev.total} tracks`;
          appendLog(els.log, `${ev.name} (${ev.total} tracks)\n`, 'line-head');
          break;
        case 'track-start':
          setState(`${ev.artist} - ${ev.track}`, 'working', '⟳', 'searching…');
          appendLog(els.log, `\n▶ ${ev.artist} - ${ev.track}`, 'line-head');
          break;
        case 'debug':
          appendLog(els.log, ev.message, classForDebug(ev.message));
          break;
        case 'matched':
          setState(ev.track, 'working', '⟳', `↳ ${ev.videoTitle} — ${ev.channel}`);
          break;
        case 'track-done':
          processed++;
          setState(ev.track, 'success', '✓', ev.file);
          els.bar.style.width = `${(processed / total) * 100}%`;
          break;
        case 'track-skip':
          processed++;
          setState(ev.track, 'nomatch', '?', ev.reason);
          appendLog(els.log, `? skipped: ${ev.reason}`, 'line-warn');
          els.bar.style.width = `${(processed / total) * 100}%`;
          break;
        case 'track-exists':
          processed++;
          setState(ev.track, 'success', '⏭', `already downloaded (${ev.file})`);
          appendLog(els.log, `⏭ already downloaded: ${ev.file}`, 'line-dim');
          els.bar.style.width = `${(processed / total) * 100}%`;
          break;
        case 'track-error':
          processed++;
          setState(ev.track, 'error', '✗', ev.error);
          appendLog(els.log, `✗ ${ev.error}`, 'line-error');
          els.bar.style.width = `${(processed / total) * 100}%`;
          break;
        case 'playlist-file':
          appendLog(els.log, `\n📃 wrote playlist: ${ev.file}`, 'line-ok');
          break;
        case 'cancelled':
          appendLog(els.log, `\n⛔ Cancelled.`, 'line-warn');
          break;
        case 'done':
          els.bar.style.width = '100%';
          els.summary.textContent =
            `Done — ${ev.ok} downloaded, ${ev.exists || 0} already had, ${ev.skipped} skipped, ${ev.failed} failed (of ${ev.total})`;
          es.close();
          finish();
          break;
        case 'error':
          appendLog(els.log, `✗ ${ev.message}`, 'line-error');
          es.close();
          finish();
          break;
      }
    }, finish);
    // Cancel must also reset the UI immediately — closing the stream alone would
    // leave the button stuck on "Converting…".
    activeStream = { close: () => { es.close(); appendLog(els.log, '\n⛔ Cancelled.', 'line-warn'); finish(); } };
  };
}

// Convert tab (Spotify playlist → MP3)
const runPlaylistConvert = makeConvertRunner({
  list: $('#convert-list'), log: convLog, bar: $('#convert-bar'),
  progress: $('#convert-progress'), summary: $('#convert-summary'),
  btn: $('#convert-btn'), btnLabel: 'Convert', cancelId: 'convert-cancel',
});
$('#convert-btn').addEventListener('click', () => {
  const playlist = $('#playlist-input').value.trim();
  if (!playlist) { $('#playlist-input').focus(); return; }
  const quality = $('#convert-quality').value;
  runPlaylistConvert(`/api/convert?${new URLSearchParams({ playlist, quality }).toString()}`);
});

// ─── Albums tab (search Spotify album → tagged MP3s) ─────────────────────────
const albumLog = $('#album-log');
let albumChosenId = '';
let albumChosenSource = 'discogs';
$('#clear-album-console').addEventListener('click', () => { albumLog.textContent = ''; });

async function searchAlbums() {
  const q = $('#album-search').value.trim();
  if (!q) { $('#album-search').focus(); return; }

  const source = $('#album-source').value === 'spotify' ? 'spotify' : 'discogs';
  const results = $('#album-results');
  results.classList.remove('hidden');
  results.innerHTML = '<option disabled>Searching…</option>';
  const btn = $('#album-search-btn');
  btn.disabled = true; btn.textContent = 'Searching…';
  const showMsg = (msg) => {
    results.innerHTML = '';
    const o = document.createElement('option');
    o.disabled = true; o.textContent = msg;
    results.appendChild(o);
  };

  try {
    const endpoint = source === 'spotify' ? '/api/spotify/search-albums' : '/api/discogs/search-albums';
    const resp = await fetch(`${endpoint}?q=${encodeURIComponent(q)}`);
    const data = await resp.json();
    if (!resp.ok || data.error) { showMsg(data.error || 'Search failed'); return; }
    if (!data.albums || data.albums.length === 0) { showMsg('No albums found'); return; }
    results.innerHTML = '';
    data.albums.forEach((a) => {
      const o = document.createElement('option');
      o.value = a.id;
      o.dataset.source = source;
      o.dataset.name = a.name || '';
      o.dataset.artist = a.artist || '';
      o.dataset.year = a.year || '';
      o.dataset.image = a.imageUrl || '';
      o.dataset.label = `${a.name}${a.artist ? ` — ${a.artist}` : ''}`;
      o.textContent =
        `${a.name}${a.artist ? ` — ${a.artist}` : ''}` +
        `${a.year ? ` (${a.year})` : ''}${a.totalTracks ? ` · ${a.totalTracks} tracks` : ''}`;
      results.appendChild(o);
    });
  } catch (e) {
    showMsg('Search failed');
  } finally {
    btn.disabled = false; btn.textContent = 'Search';
  }
}

$('#album-search-btn').addEventListener('click', searchAlbums);
$('#album-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchAlbums(); });
function fmtDuration(ms) {
  if (!ms || ms < 1000) return '';
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

async function showAlbumPreview(opt) {
  const box = $('#album-chosen');
  const name = opt.dataset.name || opt.dataset.label || '';
  const artist = opt.dataset.artist || '';
  const year = opt.dataset.year || '';
  const image = opt.dataset.image || '';
  const heading = `${name}${artist ? ` — ${artist}` : ''}${year ? ` (${year})` : ''}`;

  box.innerHTML =
    `<div class="album-preview">
       ${image ? `<img class="album-cover" alt="" />` : ''}
       <div class="album-tracks">
         <div class="album-preview-title"></div>
         <div class="album-preview-sub">via ${albumChosenSource} · loading tracklist…</div>
         <ol class="album-tracklist"></ol>
       </div>
     </div>`;
  if (image) { const img = box.querySelector('.album-cover'); img.src = image; }
  box.querySelector('.album-preview-title').textContent = heading;

  try {
    const qs = new URLSearchParams({ album: albumChosenId, source: albumChosenSource });
    const resp = await fetch(`/api/album-tracks?${qs.toString()}`);
    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(data.error || 'Could not load tracklist');
    const sub = box.querySelector('.album-preview-sub');
    sub.textContent = `via ${albumChosenSource} · ${data.tracks.length} tracks`;
    const ol = box.querySelector('.album-tracklist');
    ol.innerHTML = '';
    data.tracks.forEach((t) => {
      const li = document.createElement('li');
      const dur = fmtDuration(t.durationMs);
      li.innerHTML = `<span class="trk-title"></span>${dur ? `<span class="trk-dur">${dur}</span>` : ''}`;
      li.querySelector('.trk-title').textContent = t.title;
      ol.appendChild(li);
    });
  } catch (err) {
    const sub = box.querySelector('.album-preview-sub');
    if (sub) sub.textContent = `via ${albumChosenSource} · ${err instanceof Error ? err.message : err}`;
  }
}

$('#album-results').addEventListener('change', (e) => {
  const opt = e.target.selectedOptions[0];
  if (!opt || !opt.value) return;
  albumChosenId = opt.value;
  albumChosenSource = opt.dataset.source || 'discogs';
  $('#album-convert-btn').disabled = false;
  showAlbumPreview(opt);
});

const runAlbumConvert = makeConvertRunner({
  list: $('#album-list'), log: albumLog, bar: $('#album-bar'),
  progress: $('#album-progress'), summary: $('#album-summary'),
  btn: $('#album-convert-btn'), btnLabel: 'Download album', cancelId: 'album-cancel',
});
$('#album-convert-btn').addEventListener('click', () => {
  if (!albumChosenId) { $('#album-search').focus(); return; }
  const quality = $('#album-quality').value;
  const qs = new URLSearchParams({ album: albumChosenId, quality, source: albumChosenSource });
  runAlbumConvert(`/api/convert-album?${qs.toString()}`);
});

// ─── Songs tab (search a single track → tagged MP3) ──────────────────────────
const songLog = $('#song-log');
let songChosen = null; // { title, artist, durationMs }
$('#clear-song-console').addEventListener('click', () => { songLog.textContent = ''; });

async function searchSongs() {
  const q = $('#song-search').value.trim();
  if (!q) { $('#song-search').focus(); return; }

  const source = $('#song-source').value === 'spotify' ? 'spotify' : 'discogs';
  const results = $('#song-results');
  results.classList.remove('hidden');
  results.innerHTML = '<option disabled>Searching…</option>';
  const btn = $('#song-search-btn');
  btn.disabled = true; btn.textContent = 'Searching…';
  const showMsg = (msg) => {
    results.innerHTML = '';
    const o = document.createElement('option');
    o.disabled = true; o.textContent = msg;
    results.appendChild(o);
  };

  try {
    const resp = await fetch(`/api/songs/search?q=${encodeURIComponent(q)}&source=${source}`);
    const data = await resp.json();
    if (!resp.ok || data.error) { showMsg(data.error || 'Search failed'); return; }
    if (!data.songs || data.songs.length === 0) { showMsg('No songs found'); return; }
    results.innerHTML = '';
    data.songs.forEach((s) => {
      const o = document.createElement('option');
      o.value = s.title;
      o.dataset.title = s.title || '';
      o.dataset.artist = s.artist || '';
      o.dataset.album = s.album || '';
      o.dataset.year = s.year || '';
      o.dataset.track = s.trackNumber || '';
      o.dataset.image = s.albumArtUrl || '';
      o.dataset.duration = s.durationMs || '';
      o.dataset.source = source;
      o.textContent =
        `${s.title}${s.artist ? ` — ${s.artist}` : ''}` +
        `${s.album ? ` · ${s.album}` : ''}${s.year ? ` (${s.year})` : ''}`;
      results.appendChild(o);
    });
  } catch (e) {
    showMsg('Search failed');
  } finally {
    btn.disabled = false; btn.textContent = 'Search';
  }
}

function showSongPreview(opt) {
  const box = $('#song-chosen');
  const title = opt.dataset.title || '';
  const artist = opt.dataset.artist || '';
  const album = opt.dataset.album || '';
  const year = opt.dataset.year || '';
  const track = opt.dataset.track || '';
  const image = opt.dataset.image || '';
  const durMs = parseInt(opt.dataset.duration || '0', 10) || 0;

  const rows = [];
  if (artist) rows.push(['Artist', artist]);
  if (album) rows.push(['Album', album]);
  if (year) rows.push(['Year', year]);
  if (track) rows.push(['Track #', track]);
  if (durMs) rows.push(['Duration', fmtDuration(durMs)]);
  rows.push(['Source', opt.dataset.source || '']);

  box.innerHTML =
    `<div class="album-preview">
       ${image ? `<img class="album-cover" alt="" />` : ''}
       <div class="album-tracks">
         <div class="album-preview-title"></div>
         <dl class="song-meta"></dl>
       </div>
     </div>`;
  if (image) box.querySelector('.album-cover').src = image;
  box.querySelector('.album-preview-title').textContent = title;
  const dl = box.querySelector('.song-meta');
  rows.forEach(([k, v]) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    dl.appendChild(dt); dl.appendChild(dd);
  });
}

$('#song-search-btn').addEventListener('click', searchSongs);
$('#song-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchSongs(); });
$('#song-results').addEventListener('change', (e) => {
  const opt = e.target.selectedOptions[0];
  if (!opt || !opt.value) return;
  songChosen = {
    title: opt.dataset.title,
    artist: opt.dataset.artist,
    durationMs: parseInt(opt.dataset.duration || '0', 10) || 0,
  };
  $('#song-convert-btn').disabled = false;
  showSongPreview(opt);
});

const runSongConvert = makeConvertRunner({
  list: $('#song-list'), log: songLog, bar: $('#song-bar'),
  progress: $('#song-progress'), summary: $('#song-summary'),
  btn: $('#song-convert-btn'), btnLabel: 'Download song', cancelId: 'song-cancel',
});
$('#song-convert-btn').addEventListener('click', () => {
  if (!songChosen) { $('#song-search').focus(); return; }
  const qs = new URLSearchParams({
    title: songChosen.title,
    artist: songChosen.artist || '',
    duration: String(songChosen.durationMs || 0),
    quality: $('#song-quality').value,
  });
  runSongConvert(`/api/convert-song?${qs.toString()}`);
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
