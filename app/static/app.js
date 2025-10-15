const bucketsEl = document.getElementById('buckets');
const rowsEl = document.getElementById('rows');
const statusEl = document.getElementById('status');
const bucketTitleEl = document.getElementById('bucket-title');
const bucketActionsEl = document.getElementById('bucket-actions');
const titleSpinner = document.getElementById('title-spinner');
const listingOverlay = document.getElementById('listing-overlay');
const listingEl = document.getElementById('listing');
const breadcrumbsEl = document.getElementById('breadcrumbs');
const btnCleanup = document.getElementById('btn-cleanup');
const btnDeleteAll = document.getElementById('btn-delete-all');
const btnSmartCleanup = document.getElementById('btn-smart-cleanup');
const btnSmartCleanupFolders = document.getElementById('btn-smart-cleanup-folders');
const btnPrev = document.getElementById('prev');
const btnNext = document.getElementById('next');
const pagerSpinner = document.getElementById('pager-spinner');
const bucketsSpinner = document.getElementById('buckets-spinner');
const themeToggle = document.getElementById('theme-toggle');
const menuToggle = document.getElementById('menu-toggle');
const sidebar = document.getElementById('sidebar');
const sidebarBackdrop = document.getElementById('sidebar-backdrop');
// Preview panel elements
const previewPanel = document.getElementById('preview-panel');
const previewModal = document.getElementById('preview-modal');
const previewStatus = document.getElementById('preview-status');
const deleteProgress = document.getElementById('delete-progress');
const deleteProgressBar = document.getElementById('delete-progress-bar');
const deleteProgressText = document.getElementById('delete-progress-text');
const deleteStopBtn = document.getElementById('delete-stop');
const previewInfo = document.getElementById('preview-info');
const previewList = document.getElementById('preview-list');
const selectAll = document.getElementById('select-all');
const approveSelected = document.getElementById('approve-selected');
const approveAll = document.getElementById('approve-all');
const cancelPreview = document.getElementById('cancel-preview');
// Counts
const countFilesEl = document.getElementById('count-files');
const countFoldersEl = document.getElementById('count-folders');
const countSpinner = document.getElementById('count-spinner');

let state = {
  bucket: null,
  prefix: '',
  tokenStack: [], // for prev
  nextToken: null,
  preview: null, // { type: 'cleanup'|'smart', bucket, candidates: [{key,size,last_modified}], meta: {...} }
  sortKey: 'last_modified',
  sortDir: 'desc',
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
      li.textContent = `🪣 ${b}`;
      li.onclick = () => selectBucket(b);
      bucketsEl.appendChild(li);
    });
  } finally {
    bucketsSpinner && bucketsSpinner.classList.add('hidden');
  }
}

function renderBreadcrumbs() {
  const parts = state.prefix ? state.prefix.split('/').filter(Boolean) : [];
  const crumbs = [{ label: '🏠 root', prefix: '' }];
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
  if (pagerSpinner) pagerSpinner.classList.remove('hidden');
  btnPrev.disabled = true; btnNext.disabled = true;
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
    if (listingEl) listingEl.scrollTop = 0;
    // folders first
    data.folders.forEach(f => {
      const name = f.replace(state.prefix, '').replace(/\/$/, '');
      const tr = document.createElement('tr');
      tr.setAttribute('data-prefix', f);
      tr.innerHTML = `<td class="name-cell"><span class="link">📁 ${name}</span></td><td></td><td></td><td class="row-actions"><button class="del-btn" data-prefix="${encodeURIComponent(f)}" title="Delete this folder (prefix)" aria-label="Delete folder">🗑️</button></td>`;
      tr.querySelector('.link').onclick = () => {
        state.prefix = f; state.tokenStack = []; state.nextToken = null; updateURL(); loadListing();
      };
      const fdel = tr.querySelector('.del-btn');
      fdel.onclick = async (e) => {
        e.stopPropagation();
        const pfx = decodeURIComponent(fdel.getAttribute('data-prefix'));
        if (!confirm(`Delete entire folder (prefix)?\n\n${pfx}`)) return;
        setStatus('Deleting folder...');
        const res = await fetch(`/api/buckets/${encodeURIComponent(state.bucket)}/delete-prefixes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: [pfx] }) });
        const data = await res.json();
        if (data.error) setStatus(`Error: ${data.error}`, true);
        else setStatus(`Folder deleted: ${pfx} (objects deleted: ${data.deleted})`);
        await loadListing();
      };
      rowsEl.appendChild(tr);
    });
    // objects (sorted)
    const objs = (data.objects || []).slice();
    const dir = state.sortDir === 'desc' ? -1 : 1;
    objs.sort((a, b) => {
      let av, bv;
      if (state.sortKey === 'size') { av = a.size||0; bv = b.size||0; }
      else if (state.sortKey === 'last_modified') { av = a.last_modified ? Date.parse(a.last_modified) : 0; bv = b.last_modified ? Date.parse(b.last_modified) : 0; }
      else { av = (a.key||'').toLowerCase(); bv = (b.key||'').toLowerCase(); }
      if (av < bv) return -1*dir; if (av > bv) return 1*dir; return 0;
    });
    updateSortIndicators();
    objs.forEach(o => {
      const name = o.key.replace(state.prefix, '');
      const tr = document.createElement('tr');
      tr.setAttribute('data-key', o.key);
      const dl = `/api/buckets/${encodeURIComponent(state.bucket)}/download?key=${encodeURIComponent(o.key)}`;
      tr.innerHTML = `<td class="name-cell"><a class="icon-link" href="${dl}" title="Download" target="_blank" rel="noopener">📥</a> <span class="file-ico">📄</span>${name}</td><td>${fmtBytes(o.size)}</td><td>${o.last_modified || ''}</td><td class="row-actions"><button class="del-btn" data-key="${encodeURIComponent(o.key)}" title="Delete this file" aria-label="Delete">🗑️</button></td>`;
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
    if (pagerSpinner) pagerSpinner.classList.add('hidden');
  }
  // annotate smart-cleanup deletions for visible objects (keep small spinner visible)
  try { await annotateSmartMarkers(); }
  finally { titleSpinner && titleSpinner.classList.add('hidden'); }
  // load counts asynchronously
  loadCounts().catch(() => {});
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
  // Close sidebar on mobile after selecting a bucket
  closeSidebar();
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

if (btnSmartCleanupFolders) {
  btnSmartCleanupFolders.onclick = async () => {
    if (!state.bucket) return;
    setStatus('Preparing folder smart cleanup preview...');
    const params = new URLSearchParams();
    if (state.prefix) params.set('prefix', state.prefix);
    const res = await fetch(`/api/buckets/${encodeURIComponent(state.bucket)}/smart-cleanup-folders-preview?${params.toString()}`);
    const data = await res.json();
    if (data.error) { setStatus(`Error: ${data.error}`, true); return; }
    showPreview({ type: 'smart-folders', bucket: state.bucket, candidates: data.candidates, meta: { prefix: data.prefix, policy: data.policy, kept: data.kept, scanned: data.scanned_folders } });
  };
}

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
  // Reset progress
  if (deleteProgress) {
    deleteProgress.classList.add('hidden');
    if (deleteProgressBar) deleteProgressBar.style.width = '0%';
    if (deleteProgressText) deleteProgressText.textContent = '0%';
  }
  approveAll.disabled = preview.candidates.length === 0;
  approveSelected.disabled = true;
  selectAll.checked = false;
  setPreviewStatus('Review and approve deletions.');
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
  const noun = state.preview.type === 'smart-folders' ? 'folders' : 'files';
  if (!confirm(`Approve deletion of ALL ${n} ${noun}?`)) return;
  if (state.preview.type === 'smart-folders') {
    await submitFolderDeletions(state.preview.candidates.map(c => c.key));
  } else {
    await submitDeletions(state.preview.candidates.map(c => c.key));
  }
};

approveSelected.onclick = async () => {
  if (!state.preview || !state.bucket) return;
  const keys = [...previewList.querySelectorAll('input.candidate:checked')].map(b => decodeURIComponent(b.getAttribute('data-key')));
  if (keys.length === 0) return;
  const noun = state.preview.type === 'smart-folders' ? 'folders' : 'files';
  if (!confirm(`Approve deletion of ${keys.length} selected ${noun}?`)) return;
  if (state.preview.type === 'smart-folders') {
    await submitFolderDeletions(keys);
  } else {
    await submitDeletions(keys);
  }
};

async function submitDeletions(keys) {
  setPreviewStatus('Deleting selected files...');
  // Disable selection while deleting
  const boxes = [...previewList.querySelectorAll('input.candidate')];
  boxes.forEach(b => b.disabled = true);
  selectAll.disabled = true;
  approveSelected.disabled = true;
  approveAll.disabled = true;
  // Show progress
  if (deleteProgress) deleteProgress.classList.remove('hidden');
  let cancelled = false;
  const onStop = () => { cancelled = true; deleteStopBtn && (deleteStopBtn.disabled = true); };
  if (deleteStopBtn) {
    deleteStopBtn.disabled = false;
    deleteStopBtn.onclick = onStop;
  }
  const total = keys.length;
  let processed = 0;
  let totalDeleted = 0;
  let totalBatches = 0;
  const chunkSize = 500;
  for (let i = 0; i < keys.length; i += chunkSize) {
    if (cancelled) break;
    const chunk = keys.slice(i, i + chunkSize);
    const res = await fetch(`/api/buckets/${encodeURIComponent(state.bucket)}/delete-keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: chunk })
    });
    const data = await res.json();
    if (data.error) { setPreviewStatus(`Error: ${data.error}`, true); break; }
    totalDeleted += (data.deleted || 0);
    totalBatches += (data.batches || 0);
    processed += chunk.length;
    const pct = Math.min(100, Math.round(processed * 100 / total));
    if (deleteProgressBar) deleteProgressBar.style.width = pct + '%';
    if (deleteProgressText) deleteProgressText.textContent = `${processed}/${total} (${pct}%)`;
  }
  if (deleteStopBtn) deleteStopBtn.onclick = null;
  if (cancelled) {
    setPreviewStatus(`Deletion cancelled at ${processed}/${total}. Deleted ${totalDeleted}.`);
  } else {
    setPreviewStatus(`Deleted ${totalDeleted} objects in ${totalBatches} requests.`);
  }
  hidePreviewModal();
  await loadListing();
}

async function submitFolderDeletions(prefixes) {
  setPreviewStatus('Deleting selected folders...');
  // Disable controls
  const boxes = [...previewList.querySelectorAll('input.candidate')];
  boxes.forEach(b => b.disabled = true);
  selectAll.disabled = true;
  approveSelected.disabled = true;
  approveAll.disabled = true;
  if (deleteProgress) deleteProgress.classList.remove('hidden');
  let cancelled = false;
  const onStop = () => { cancelled = true; deleteStopBtn && (deleteStopBtn.disabled = true); };
  if (deleteStopBtn) { deleteStopBtn.disabled = false; deleteStopBtn.onclick = onStop; }
  const total = prefixes.length;
  let processed = 0;
  let totalDeleted = 0;
  let totalBatches = 0;
  const step = 10; // delete 10 folders per request
  for (let i = 0; i < prefixes.length; i += step) {
    if (cancelled) break;
    const chunk = prefixes.slice(i, i + step);
    const res = await fetch(`/api/buckets/${encodeURIComponent(state.bucket)}/delete-prefixes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: chunk })
    });
    const data = await res.json();
    if (data.error) { setPreviewStatus(`Error: ${data.error}`, true); break; }
    totalDeleted += (data.deleted || 0);
    totalBatches += (data.batches || 0);
    processed += chunk.length;
    const pct = Math.min(100, Math.round(processed * 100 / total));
    if (deleteProgressBar) deleteProgressBar.style.width = pct + '%';
    if (deleteProgressText) deleteProgressText.textContent = `${processed}/${total} (${pct}%)`;
  }
  if (deleteStopBtn) deleteStopBtn.onclick = null;
  if (cancelled) {
    setPreviewStatus(`Folder deletion cancelled at ${processed}/${total}. Deleted ${totalDeleted}.`);
  } else {
    setPreviewStatus(`Deleted ${totalDeleted} objects in ${totalBatches} requests.`);
  }
  hidePreviewModal();
  await loadListing();
}

loadBuckets().catch(e => setStatus(String(e), true));

// Initialize theme after DOM is ready
initTheme();
initSortHeaders();

// Sidebar toggle for mobile
function openSidebar() {
  document.body.classList.add('sidebar-open');
  if (menuToggle) menuToggle.setAttribute('aria-expanded', 'true');
}
function closeSidebar() {
  document.body.classList.remove('sidebar-open');
  if (menuToggle) menuToggle.setAttribute('aria-expanded', 'false');
}
function toggleSidebar() {
  if (document.body.classList.contains('sidebar-open')) closeSidebar();
  else openSidebar();
}
if (menuToggle) menuToggle.onclick = toggleSidebar;
if (sidebarBackdrop) sidebarBackdrop.onclick = closeSidebar;

async function annotateSmartMarkers() {
  // Remove previous markers
  [...rowsEl.querySelectorAll('.smart-del')].forEach(el => el.remove());
  if (!state.bucket) return;
  const params = new URLSearchParams();
  if (state.prefix) params.set('prefix', state.prefix);
  // Objects
  const res = await fetch(`/api/buckets/${encodeURIComponent(state.bucket)}/smart-cleanup-preview?${params.toString()}`);
  const data = await res.json();
  if (!data.error) {
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
  // Folders
  const res2 = await fetch(`/api/buckets/${encodeURIComponent(state.bucket)}/smart-cleanup-folders-preview?${params.toString()}`);
  const data2 = await res2.json();
  if (!data2.error) {
    const delPfx = new Set((data2.candidates || []).map(c => c.key));
    const frows = [...rowsEl.querySelectorAll('tr[data-prefix]')];
    frows.forEach(tr => {
      const pfx = tr.getAttribute('data-prefix');
      if (delPfx.has(pfx)) {
        const td = tr.querySelector('td.name-cell');
        if (!td) return;
        const icon = document.createElement('span');
        icon.className = 'smart-del';
        icon.title = 'Folder will be removed by Smart cleanup';
        icon.textContent = '⚠️';
        td.appendChild(document.createTextNode(' '));
        td.appendChild(icon);
      }
    });
  }
}


function updateSortIndicators() {
  const ths = document.querySelectorAll('thead th[data-sort]');
  ths.forEach(th => {
    const key = th.getAttribute('data-sort');
    const icon = th.querySelector('.sort-icon');
    th.classList.toggle('sorted', key === state.sortKey);
    if (icon) icon.textContent = key === state.sortKey ? (state.sortDir === 'desc' ? '▼' : '▲') : '';
  });
}

function initSortHeaders() {
  const ths = document.querySelectorAll('thead th[data-sort]');
  ths.forEach(th => {
    th.onclick = () => {
      const key = th.getAttribute('data-sort');
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc';
      } else {
        state.sortKey = key;
        state.sortDir = key === 'last_modified' ? 'desc' : 'asc';
      }
      // Re-render current page by reloading listing (keeps pagination correct)
      loadListing();
    };
  });
  updateSortIndicators();
}

async function loadCounts() {
  if (!state.bucket) return;
  if (countSpinner) countSpinner.classList.remove('hidden');
  try {
    const params = new URLSearchParams();
    if (state.prefix) params.set('prefix', state.prefix);
    const res = await fetch(`/api/buckets/${encodeURIComponent(state.bucket)}/counts?${params.toString()}`);
    const data = await res.json();
    if (!data || data.error) return;
    if (countFilesEl) countFilesEl.textContent = data.files ?? 0;
    if (countFoldersEl) countFoldersEl.textContent = data.folders ?? 0;
  } finally {
    if (countSpinner) countSpinner.classList.add('hidden');
  }
}

function hidePreviewModal() {
  if (previewModal) previewModal.classList.add('hidden');
  state.preview = null;
  setPreviewStatus('');
}

// Close modal when clicking outside dialog or pressing Escape
if (previewModal) {
  previewModal.addEventListener('click', (e) => {
    if (e.target === previewModal) hidePreviewModal();
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (previewModal && !previewModal.classList.contains('hidden')) {
      hidePreviewModal();
    } else if (document.body.classList.contains('sidebar-open')) {
      closeSidebar();
    }
  }
});

function setPreviewStatus(msg, isError = false) {
  if (!previewStatus) return;
  previewStatus.textContent = msg || '';
  previewStatus.classList.toggle('error', !!isError);
  previewStatus.classList.toggle('hidden', !msg);
}

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
