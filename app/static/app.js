const bucketsEl = document.getElementById('buckets');
const rowsEl = document.getElementById('rows');
const statusEl = document.getElementById('status');
const bucketTitleEl = document.getElementById('bucket-title');
const bucketActionsEl = document.getElementById('bucket-actions');
const titleSpinner = document.getElementById('title-spinner');
const listingOverlay = document.getElementById('listing-overlay');
const breadcrumbsEl = document.getElementById('breadcrumbs');
const btnCleanup = document.getElementById('btn-cleanup');
const btnDeleteAll = document.getElementById('btn-delete-all');
const btnSmartCleanup = document.getElementById('btn-smart-cleanup');
const btnPrev = document.getElementById('prev');
const btnNext = document.getElementById('next');
const bucketsSpinner = document.getElementById('buckets-spinner');
const themeToggle = document.getElementById('theme-toggle');
// Preview panel elements
const previewPanel = document.getElementById('preview-panel');
const previewModal = document.getElementById('preview-modal');
const previewInfo = document.getElementById('preview-info');
const previewList = document.getElementById('preview-list');
const selectAll = document.getElementById('select-all');
const approveSelected = document.getElementById('approve-selected');
const approveAll = document.getElementById('approve-all');
const cancelPreview = document.getElementById('cancel-preview');

let state = {
  bucket: null,
  prefix: '',
  tokenStack: [], // for prev
  nextToken: null,
  preview: null, // { type: 'cleanup'|'smart', bucket, candidates: [{key,size,last_modified}], meta: {...} }
};

// Theme handling (Auto/Light/Dark) with daytime-based auto and persistence
const THEME_KEY = 'ws3c:themeMode'; // auto|light|dark
function getThemeMode() {
  return localStorage.getItem(THEME_KEY) || 'auto';
}
function setThemeMode(mode) {
  localStorage.setItem(THEME_KEY, mode);
}
function computeAutoTheme() {
  const now = new Date();
  const h = now.getHours();
  // Light during day (07:00–18:59), Dark otherwise
  return (h >= 7 && h < 19) ? 'light' : 'dark';
}
function applyTheme(mode = getThemeMode()) {
  const m = mode === 'auto' ? computeAutoTheme() : mode;
  document.documentElement.setAttribute('data-theme', m);
  const icon = mode === 'auto' ? '🌓' : (mode === 'light' ? '☀️' : '🌙');
  themeToggle.textContent = icon;
  themeToggle.title = `Theme: ${mode.charAt(0).toUpperCase() + mode.slice(1)}`;
  themeToggle.setAttribute('aria-label', themeToggle.title);
}
let autoTimer = null;
function scheduleAutoRecalc() {
  if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
  if (getThemeMode() !== 'auto') return;
  const now = new Date();
  const h = now.getHours();
  // Next boundary at 07:00 or 19:00 local time
  let next = new Date(now);
  if (h < 7) {
    next.setHours(7, 0, 0, 0);
  } else if (h < 19) {
    next.setHours(19, 0, 0, 0);
  } else {
    next.setDate(next.getDate() + 1);
    next.setHours(7, 0, 0, 0);
  }
  const delay = Math.max(1, next - now);
  autoTimer = setTimeout(() => { applyTheme('auto'); scheduleAutoRecalc(); }, delay);
}
function initTheme() {
  applyTheme();
  scheduleAutoRecalc();
}
themeToggle.onclick = () => {
  const cur = getThemeMode();
  const next = cur === 'auto' ? 'light' : cur === 'light' ? 'dark' : 'auto';
  setThemeMode(next);
  applyTheme(next);
  scheduleAutoRecalc();
};

function fmtBytes(bytes) {
  if (bytes === 0) return '0 B';
  if (!bytes) return '';
  const k = 1024, sizes = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function setStatus(msg, isError = false) {
  statusEl.style.color = isError ? '#fca5a5' : '#22c55e';
  statusEl.textContent = msg || '';
}

async function loadBuckets() {
  try {
    bucketsSpinner && bucketsSpinner.classList.remove('hidden');
    const res = await fetch('/api/buckets');
    const data = await res.json();
    bucketsEl.innerHTML = '';
    data.buckets.forEach(b => {
      const li = document.createElement('li');
      li.textContent = b;
      li.onclick = () => selectBucket(b);
      bucketsEl.appendChild(li);
    });
  } finally {
    bucketsSpinner && bucketsSpinner.classList.add('hidden');
  }
}

function renderBreadcrumbs() {
  const parts = state.prefix ? state.prefix.split('/').filter(Boolean) : [];
  const crumbs = [{ label: '(root)', prefix: '' }];
  let cur = '';
  for (const p of parts) {
    cur += p + '/';
    crumbs.push({ label: p, prefix: cur });
  }
  breadcrumbsEl.innerHTML = crumbs.map((c, i) => `<span class="link" data-prefix="${c.prefix}">${c.label}</span>${i < crumbs.length-1 ? ' / ' : ''}`).join('');
  [...breadcrumbsEl.querySelectorAll('.link')].forEach(el => {
    el.onclick = () => {
      const prefix = el.getAttribute('data-prefix');
      state.prefix = prefix;
      state.tokenStack = [];
      state.nextToken = null;
      updateURL();
      loadListing();
    };
  });
}

async function loadListing(token) {
  if (!state.bucket) return;
  setStatus('');
  titleSpinner && titleSpinner.classList.remove('hidden');
  listingOverlay && listingOverlay.classList.remove('hidden');
  try {
    const params = new URLSearchParams();
    if (state.prefix) params.set('prefix', state.prefix);
    if (token) params.set('token', token);
    const res = await fetch(`/api/buckets/${encodeURIComponent(state.bucket)}/list?${params.toString()}`);
    const data = await res.json();
    if (data.error) {
      setStatus(`Error: ${data.error}`, true);
      return;
    }
    rowsEl.innerHTML = '';
    // folders first
    data.folders.forEach(f => {
      const name = f.replace(state.prefix, '').replace(/\/$/, '');
      const tr = document.createElement('tr');
      tr.innerHTML = `<td><span class="link">📁 ${name}</span></td><td></td><td></td><td></td>`;
      tr.querySelector('.link').onclick = () => {
        state.prefix = f; state.tokenStack = []; state.nextToken = null; updateURL(); loadListing();
      };
      rowsEl.appendChild(tr);
    });
    // objects
    data.objects.forEach(o => {
      const name = o.key.replace(state.prefix, '');
      const tr = document.createElement('tr');
      tr.setAttribute('data-key', o.key);
      const dl = `/api/buckets/${encodeURIComponent(state.bucket)}/download?key=${encodeURIComponent(o.key)}`;
      tr.innerHTML = `<td class="name-cell"><a class="icon-link" href="${dl}" title="Download" target="_blank" rel="noopener">⬇️</a> ${name}</td><td>${fmtBytes(o.size)}</td><td>${o.last_modified || ''}</td><td class="row-actions"><button class="del-btn" data-key="${encodeURIComponent(o.key)}" title="Delete this file" aria-label="Delete">🗑️</button></td>`;
      rowsEl.appendChild(tr);
      const btn = tr.querySelector('.del-btn');
      btn.onclick = async () => {
        const key = decodeURIComponent(btn.getAttribute('data-key'));
        if (!confirm(`Delete this file?\n\n${key}`)) return;
        await submitDeletions([key]);
      };
    });
    state.nextToken = data.next_token || null;
    btnNext.disabled = !state.nextToken;
    btnPrev.disabled = state.tokenStack.length === 0;
    renderBreadcrumbs();
  } finally {
    listingOverlay && listingOverlay.classList.add('hidden');
  }
  // annotate smart-cleanup deletions for visible objects (keep small spinner visible)
  try { await annotateSmartMarkers(); }
  finally { titleSpinner && titleSpinner.classList.add('hidden'); }
}

function selectBucket(bucket) {
  state.bucket = bucket;
  state.prefix = '';
  state.tokenStack = [];
  state.nextToken = null;
  bucketTitleEl.textContent = bucket;
  bucketActionsEl.classList.remove('hidden');
  updateURL();
  loadListing();
}

btnNext.onclick = () => {
  if (state.nextToken) {
    state.tokenStack.push(state.nextToken);
    loadListing(state.nextToken);
  }
};
btnPrev.onclick = () => {
  if (state.tokenStack.length > 1) {
    state.tokenStack.pop();
    const prev = state.tokenStack[state.tokenStack.length - 1];
    loadListing(prev);
  } else {
    state.tokenStack = [];
    loadListing();
  }
};

btnCleanup.onclick = async () => {
  if (!state.bucket) return;
  setStatus('Preparing cleanup preview...');
  const params = new URLSearchParams();
  if (state.prefix) params.set('prefix', state.prefix);
  params.set('days', '30');
  const res = await fetch(`/api/buckets/${encodeURIComponent(state.bucket)}/cleanup-preview?${params.toString()}`);
  const data = await res.json();
  if (data.error) { setStatus(`Error: ${data.error}`, true); return; }
  showPreview({ type: 'cleanup', bucket: state.bucket, candidates: data.candidates, meta: { days: data.days, prefix: data.prefix } });
};

btnDeleteAll.onclick = async () => {
  if (!state.bucket) return;
  // Triple confirmation: two confirms + bucket name prompt
  if (!confirm(`Delete ALL objects in ${state.bucket}? (1/3)`)) return;
  if (!confirm('This action is irreversible. Continue? (2/3)')) return;
  const typed = prompt(`Type the bucket name to confirm (3/3):`);
  if (typed !== state.bucket) { setStatus('Bucket name mismatch. Aborted.', true); return; }
  setStatus('Deleting all objects...');
  const res = await fetch(`/api/buckets/${encodeURIComponent(state.bucket)}/delete-all`, { method: 'POST' });
  const data = await res.json();
  if (data.error) setStatus(`Error: ${data.error}`, true);
  else setStatus(`Delete-all done. Deleted ${data.deleted} objects in ${data.batches} batches.`);
  await loadListing();
};

btnSmartCleanup.onclick = async () => {
  if (!state.bucket) return;
  setStatus('Preparing smart cleanup preview...');
  const params = new URLSearchParams();
  if (state.prefix) params.set('prefix', state.prefix);
  const res = await fetch(`/api/buckets/${encodeURIComponent(state.bucket)}/smart-cleanup-preview?${params.toString()}`);
  const data = await res.json();
  if (data.error) { setStatus(`Error: ${data.error}`, true); return; }
  showPreview({ type: 'smart', bucket: state.bucket, candidates: data.candidates, meta: { prefix: data.prefix, policy: data.policy, kept: data.kept, scanned: data.scanned } });
};

function showPreview(preview) {
  state.preview = preview;
  // Render basic info
  const scope = preview.meta.prefix ? `Prefix "${preview.meta.prefix}"` : 'Entire bucket';
  const extra = preview.type === 'cleanup' ? `(> ${preview.meta.days} days)` : '(smart policy)';
  previewInfo.textContent = `${scope} — ${preview.candidates.length} files planned for deletion ${extra}`;
  // Render list
  previewList.innerHTML = '';
  const frag = document.createDocumentFragment();
  preview.candidates.forEach((c, idx) => {
    const row = document.createElement('div');
    row.className = 'preview-item';
    row.innerHTML = `
      <input type="checkbox" class="candidate" data-key="${encodeURIComponent(c.key)}" />
      <div class="path">${c.key}</div>
      <div class="muted">${c.last_modified || ''}</div>
      <div class="muted">${fmtBytes(c.size)}</div>
    `;
    frag.appendChild(row);
  });
  previewList.appendChild(frag);
  // Show modal
  previewModal && previewModal.classList.remove('hidden');
  approveAll.disabled = preview.candidates.length === 0;
  approveSelected.disabled = true;
  selectAll.checked = false;
  setStatus('Review and approve deletions.');
  wirePreviewSelection();
}

function wirePreviewSelection() {
  const boxes = [...previewList.querySelectorAll('input.candidate')];
  const refresh = () => {
    const any = boxes.some(b => b.checked);
    approveSelected.disabled = !any;
    // Keep select-all in sync
    selectAll.checked = boxes.length > 0 && boxes.every(b => b.checked);
  };
  boxes.forEach(b => b.onchange = refresh);
  selectAll.onchange = () => { boxes.forEach(b => b.checked = selectAll.checked); refresh(); };
  refresh();
}

cancelPreview.onclick = () => { hidePreviewModal(); };

approveAll.onclick = async () => {
  if (!state.preview || !state.bucket) return;
  const n = state.preview.candidates.length;
  if (n === 0) return;
  if (!confirm(`Approve deletion of ALL ${n} files?`)) return;
  await submitDeletions(state.preview.candidates.map(c => c.key));
};

approveSelected.onclick = async () => {
  if (!state.preview || !state.bucket) return;
  const keys = [...previewList.querySelectorAll('input.candidate:checked')].map(b => decodeURIComponent(b.getAttribute('data-key')));
  if (keys.length === 0) return;
  if (!confirm(`Approve deletion of ${keys.length} selected files?`)) return;
  await submitDeletions(keys);
};

async function submitDeletions(keys) {
  setStatus('Deleting selected files...');
  const res = await fetch(`/api/buckets/${encodeURIComponent(state.bucket)}/delete-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys })
  });
  const data = await res.json();
  if (data.error) { setStatus(`Error: ${data.error}`, true); return; }
  setStatus(`Deleted ${data.deleted} objects in ${data.batches} batches.`);
  hidePreviewModal();
  await loadListing();
}

loadBuckets().catch(e => setStatus(String(e), true));

// Initialize theme after DOM is ready
initTheme();

async function annotateSmartMarkers() {
  // Remove previous markers
  [...rowsEl.querySelectorAll('.smart-del')].forEach(el => el.remove());
  if (!state.bucket) return;
  const params = new URLSearchParams();
  if (state.prefix) params.set('prefix', state.prefix);
  const res = await fetch(`/api/buckets/${encodeURIComponent(state.bucket)}/smart-cleanup-preview?${params.toString()}`);
  const data = await res.json();
  if (data.error) return; // silently ignore
  const delSet = new Set((data.candidates || []).map(c => c.key));
  const rows = [...rowsEl.querySelectorAll('tr[data-key]')];
  rows.forEach(tr => {
    const key = tr.getAttribute('data-key');
    if (delSet.has(key)) {
      const td = tr.querySelector('td.name-cell');
      if (!td) return;
      const icon = document.createElement('span');
      icon.className = 'smart-del';
      icon.title = 'Will be removed by Smart cleanup';
      icon.textContent = '⚠️';
      td.appendChild(document.createTextNode(' '));
      td.appendChild(icon);
    }
  });
}

function hidePreviewModal() {
  if (previewModal) previewModal.classList.add('hidden');
  state.preview = null;
}

// Close modal when clicking outside dialog or pressing Escape
if (previewModal) {
  previewModal.addEventListener('click', (e) => {
    if (e.target === previewModal) hidePreviewModal();
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && previewModal && !previewModal.classList.contains('hidden')) hidePreviewModal();
});

// (Header collapse removed)

// URL sync (bucket/prefix in path)
function buildPath(bucket, prefix) {
  if (!bucket) return '/';
  if (prefix) {
    const clean = prefix.replace(/^\/+/, '');
    // keep segments as path for readability
    const segs = clean.split('/').filter(Boolean).map(encodeURIComponent).join('/');
    return `/b/${encodeURIComponent(bucket)}/p/${segs}/`;
  }
  return `/b/${encodeURIComponent(bucket)}`;
}

function updateURL(replace=false) {
  const url = buildPath(state.bucket, state.prefix);
  const st = { bucket: state.bucket, prefix: state.prefix };
  if (replace) history.replaceState(st, '', url); else history.pushState(st, '', url);
}

function parsePath() {
  const path = location.pathname;
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'b' && parts[1]) {
    const bucket = decodeURIComponent(parts[1]);
    let prefix = '';
    if (parts[2] === 'p') {
      const rest = parts.slice(3).map(decodeURIComponent).join('/');
      prefix = rest;
      if (prefix && !prefix.endsWith('/')) prefix += '/';
    }
    return { bucket, prefix };
  }
  return null;
}

window.addEventListener('popstate', (ev) => {
  const parsed = parsePath();
  if (parsed && parsed.bucket) {
    state.bucket = parsed.bucket;
    state.prefix = parsed.prefix || '';
    state.tokenStack = [];
    state.nextToken = null;
    bucketTitleEl.textContent = state.bucket;
    bucketActionsEl.classList.remove('hidden');
    loadListing();
  }
});

// Initial path handling
const initial = parsePath();
if (initial && initial.bucket) {
  state.bucket = initial.bucket;
  state.prefix = initial.prefix || '';
  // reflect current without adding to history again
  updateURL(true);
  bucketTitleEl.textContent = state.bucket;
  bucketActionsEl.classList.remove('hidden');
  loadListing();
}
