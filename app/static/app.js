const bucketsEl = document.getElementById('buckets');
const rowsEl = document.getElementById('rows');
const statusEl = document.getElementById('status');
const bucketTitleEl = document.getElementById('bucket-title');
const bucketActionsEl = document.getElementById('bucket-actions');
const titleSpinner = document.getElementById('title-spinner');
const listingOverlay = document.getElementById('listing-overlay');
const listingEl = document.getElementById('listing');
const breadcrumbsEl = document.getElementById('breadcrumbs');
const btnDeleteAll = document.getElementById('btn-delete-all');
const btnSmartCleanup = document.getElementById('btn-smart-cleanup');
const btnSmartCleanupFolders = document.getElementById('btn-smart-cleanup-folders');
const btnRefresh = document.getElementById('btn-refresh');
const btnPrev = document.getElementById('prev');
const btnNext = document.getElementById('next');
const pagerSpinner = document.getElementById('pager-spinner');
const pagerEl = document.getElementById('pager');
const bucketsSpinner = document.getElementById('buckets-spinner');
const themeToggle = document.getElementById('theme-toggle');
const menuToggle = document.getElementById('menu-toggle');
const sidebar = document.getElementById('sidebar');
const sidebarBackdrop = document.getElementById('sidebar-backdrop');
const landingEl = document.getElementById('landing');
const bucketsGrid = document.getElementById('buckets-grid');
const homeLink = document.getElementById('home-link');
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
const cancelPreview = document.getElementById('cancel-preview');
// Counts
const countFilesEl = document.getElementById('count-files');
const countFoldersEl = document.getElementById('count-folders');
const countSpinner = document.getElementById('count-spinner');

// Auto-refresh config for listing view
const LISTING_REFRESH_MS = 30000; // 30s
let listingAutoTimer = null;
let listingLoading = false;

function startListingAutoRefresh() {
  if (listingAutoTimer) { clearInterval(listingAutoTimer); listingAutoTimer = null; }
  listingAutoTimer = setInterval(() => {
    if (state.bucket && !listingLoading) {
      // Avoid overlapping loads
      try { loadListing(); } catch (_) {}
    }
  }, LISTING_REFRESH_MS);
}

function stopListingAutoRefresh() {
  if (listingAutoTimer) {
    clearInterval(listingAutoTimer);
    listingAutoTimer = null;
  }
}

let state = {
  bucket: null,
  prefix: '',
  tokenStack: [], // for prev
  nextToken: null,
  preview: null, // { type: 'smart'|'smart-folders'|'all', bucket, candidates: [...], meta: {...} }
  sortKey: 'last_modified',
  sortDir: 'desc',
  // Separate eligibility for files vs folders
  smartEligibleFiles: false,
  smartEligibleFolders: false,
};

// Heuristic: does a name contain a timestamp-like pattern?
function hasTimestampLike(s) {
  if (!s) return false;
  // Typical patterns: YYYY-MM-DD[[_|T]HH[:|-]MM([:|-]SS)?], YYYYMMDD([T]HHMMSS)?
  const patterns = [
    /\d{4}-\d{2}-\d{2}[T_ ]\d{1,2}[:\-]\d{2}(?:[:\-]\d{2})?/, // 2025-05-02_6-17[-|:]48
    /\d{8}[T_ ]?\d{6}/,                                            // 20250502T061748 or 20250502 061748
    /\d{4}-\d{2}-\d{2}(?!\d)/,                                    // 2025-05-02 (not followed by digit)
    /(?:^|[^0-9])\d{8}(?!\d)/,                                     // 20250502 (standalone 8 digits)
    /(?:^|[^0-9])\d{10}(?!\d)/,                                    // Unix epoch seconds
    /(?:^|[^0-9])\d{13}(?!\d)/,                                    // Unix epoch milliseconds
  ];
  return patterns.some(rx => rx.test(s));
}

function updateSmartUIVisibility(filesEligible, foldersEligible) {
  state.smartEligibleFiles = !!filesEligible;
  state.smartEligibleFolders = !!foldersEligible;
  if (btnSmartCleanup) btnSmartCleanup.classList.toggle('hidden', !state.smartEligibleFiles);
  if (btnSmartCleanupFolders) btnSmartCleanupFolders.classList.toggle('hidden', !state.smartEligibleFolders);
}

// Robust date parsing that handles variants like "YYYY-MM-DD HH:MM:SS+00:00"
function parseDateFlexible(dt) {
  if (!dt) return null;
  if (dt instanceof Date) return isNaN(dt.getTime()) ? null : dt;
  try {
    if (typeof dt === 'string') {
      let s = dt.trim();
      // Normalize space between date and time to 'T'
      if (s.length >= 19 && s[10] === ' ') s = s.slice(0, 10) + 'T' + s.slice(11);
      // Normalize explicit UTC offset +00:00 to Z
      s = s.replace(/\+00:00$/, 'Z');
      const d = new Date(s);
      if (!isNaN(d.getTime())) return d;
    }
    const d2 = new Date(dt);
    return isNaN(d2.getTime()) ? null : d2;
  } catch (_) {
    return null;
  }
}

// Absolute local date-time for display fallback
function formatLocalDate(dt) {
  const d = parseDateFlexible(dt);
  if (!d) return dt ? String(dt) : '';
  if (typeof d.toLocaleString === 'function') {
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
  }
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Exact timestamp for tooltip (ISO 8601 UTC, with Z)
function formatExactTimestamp(dt) {
  if (!dt && dt !== 0) return '';
  // If backend provided a string, normalize +00:00 to Z and space to T
  if (typeof dt === 'string') {
    let s = dt.trim();
    if (s.length >= 19 && s[10] === ' ') s = s.slice(0, 10) + 'T' + s.slice(11);
    s = s.replace(/\+00:00$/, 'Z');
    return s;
  }
  const d = parseDateFlexible(dt);
  if (!d) return String(dt);
  try { return d.toISOString(); } catch (_) { return String(dt); }
}

// Relative time like "2 d ago" / "3 h ago"
function formatRelativeTime(dt) {
  const d = parseDateFlexible(dt);
  if (!d) return '';
  const now = new Date();
  let diff = Math.floor((now - d) / 1000); // seconds
  const future = diff < 0;
  diff = Math.abs(diff);
  const min = 60, hour = 3600, day = 86400, month = 2592000, year = 31536000;
  let val, unit;
  if (diff < 10) return 'now';
  if (diff < min) { val = Math.floor(diff); unit = 's'; }
  else if (diff < hour) { val = Math.floor(diff / min); unit = 'm'; }
  else if (diff < day) { val = Math.floor(diff / hour); unit = 'h'; }
  else if (diff < month) { val = Math.floor(diff / day); unit = 'd'; }
  else if (diff < year) { val = Math.floor(diff / month); unit = 'mo'; }
  else { val = Math.floor(diff / year); unit = 'y'; }
  return future ? `in ${val}${unit}` : `${val}${unit} ago`;
}

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
    // Render landing grid
    if (bucketsGrid) {
      if (!data.buckets || data.buckets.length === 0) {
        bucketsGrid.innerHTML = '<div class="muted">No buckets found.</div>';
      } else {
        const frag = document.createDocumentFragment();
        data.buckets.forEach(b => {
          const card = document.createElement('div');
          card.className = 'bucket-card';
          card.setAttribute('role', 'button');
          card.setAttribute('tabindex', '0');
          card.innerHTML = `<div class="icon">🪣</div><div class="name">${b}</div>`;
          card.onclick = () => selectBucket(b);
          card.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectBucket(b); } };
          frag.appendChild(card);
        });
        bucketsGrid.innerHTML = '';
        bucketsGrid.appendChild(frag);
      }
    }
  } finally {
    bucketsSpinner && bucketsSpinner.classList.add('hidden');
  }
}

function renderBreadcrumbs() {
  const parts = state.prefix ? state.prefix.split('/').filter(Boolean) : [];
  // Show the bucket name as the root breadcrumb
  const rootLabel = state.bucket ? `🪣 ${state.bucket}` : '🏠 root';
  const crumbs = [{ label: rootLabel, prefix: '' }];
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
  if (listingLoading) return;
  listingLoading = true;
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
    // Reset table layout state before rendering
    const tableEl = listingEl ? listingEl.querySelector('table') : null;
    if (tableEl) tableEl.classList.remove('folders-only');
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
      else if (state.sortKey === 'last_modified') {
        const ad = parseDateFlexible(a.last_modified); const bd = parseDateFlexible(b.last_modified);
        av = ad ? ad.getTime() : 0; bv = bd ? bd.getTime() : 0;
      }
      else { av = (a.key||'').toLowerCase(); bv = (b.key||'').toLowerCase(); }
      if (av < bv) return -1*dir; if (av > bv) return 1*dir; return 0;
    });
    updateSortIndicators();
    objs.forEach(o => {
      const name = o.key.replace(state.prefix, '');
      const tr = document.createElement('tr');
      tr.setAttribute('data-key', o.key);
      const dl = `/api/buckets/${encodeURIComponent(state.bucket)}/download?key=${encodeURIComponent(o.key)}`;
      const rel = formatRelativeTime(o.last_modified);
      const exact = formatExactTimestamp(o.last_modified);
      const abs = formatLocalDate(o.last_modified);
      tr.innerHTML = `
        <td class="name-cell"><span class="link" role="link" tabindex="0" title="Download file"><span class="file-ico">📄</span>${name}</span></td>
        <td>${fmtBytes(o.size)}</td>
        <td title="${exact}">${rel || abs}</td>
        <td class="row-actions">
          <button class="del-btn" data-key="${encodeURIComponent(o.key)}" title="Delete this file" aria-label="Delete">🗑️</button>
        </td>`;
      rowsEl.appendChild(tr);
      // Clicking the file name downloads it in a new tab
      const fileLink = tr.querySelector('td.name-cell .link');
      if (fileLink) {
        fileLink.onclick = (e) => {
          e.preventDefault();
          window.open(dl, '_blank', 'noopener');
        };
        fileLink.onkeydown = (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            window.open(dl, '_blank', 'noopener');
          }
        };
      }
      const btn = tr.querySelector('.del-btn');
      btn.onclick = async () => {
        const key = decodeURIComponent(btn.getAttribute('data-key'));
        if (!confirm(`Delete this file?\n\n${key}`)) return;
        await submitDeletions([key]);
      };
    });
    // Decide if smart cleanup should be visible based on timestamped files/folders separately
    try {
      const filesEligible = Array.isArray(data.objects) && data.objects.some(o => {
        const nm = o && o.key ? o.key.split('/').pop() : '';
        return nm && hasTimestampLike(nm);
      });
      const foldersEligible = Array.isArray(data.folders) && data.folders.some(f => {
        const nm = (f || '').replace(state.prefix, '').replace(/\/$/, '');
        return nm && hasTimestampLike(nm);
      });
      updateSmartUIVisibility(filesEligible, foldersEligible);
    } catch (_) {
      updateSmartUIVisibility(false, false);
    }
    // If this page shows only folders (no files), hide Size/Modified columns
    if (tableEl) {
      const hasFiles = Array.isArray(data.objects) && data.objects.length > 0;
      const hasFolders = Array.isArray(data.folders) && data.folders.length > 0;
      tableEl.classList.toggle('folders-only', !hasFiles && hasFolders);
    }
    state.nextToken = data.next_token || null;
  btnNext.disabled = !state.nextToken;
  btnPrev.disabled = state.tokenStack.length === 0;
  renderBreadcrumbsTopBar();
  } finally {
    listingOverlay && listingOverlay.classList.add('hidden');
    if (pagerSpinner) pagerSpinner.classList.add('hidden');
    if (pagerEl) pagerEl.classList.toggle('hidden', btnPrev.disabled && btnNext.disabled);
  }
  // annotate smart-cleanup markers for visible rows only when relevant
  try { if (state.smartEligibleFiles || state.smartEligibleFolders) await annotateSmartMarkers(); }
  finally {
    titleSpinner && titleSpinner.classList.add('hidden');
    listingLoading = false;
  }
  // load counts asynchronously
  loadCounts().catch(() => {});
}

// New breadcrumbs renderer that includes Home and uses the title space
function renderBreadcrumbsTopBar() {
  const parts = state.prefix ? state.prefix.split('/').filter(Boolean) : [];
  const crumbs = [{ type: 'home', label: '🏠 home' }];
  if (state.bucket) crumbs.push({ type: 'bucket', label: `🪣 ${state.bucket}`, prefix: '' });
  let cur = '';
  for (const p of parts) { cur += p + '/'; crumbs.push({ type: 'prefix', label: p, prefix: cur }); }
  const html = crumbs
    .map((c, i) => `<span class="link" data-type="${c.type}"${c.prefix !== undefined ? ` data-prefix="${c.prefix}"` : ''}>${c.label}</span>${i < crumbs.length-1 ? ' / ' : ''}`)
    .join('');
  if (bucketTitleEl) bucketTitleEl.innerHTML = html;
  if (breadcrumbsEl) { breadcrumbsEl.classList.add('hidden'); breadcrumbsEl.innerHTML = html; }
  const container = bucketTitleEl || breadcrumbsEl;
  if (!container) return;
  [...container.querySelectorAll('.link')].forEach(el => {
    el.onclick = () => {
      const type = el.getAttribute('data-type');
      if (type === 'home') { goHome(); return; }
      if (type === 'bucket') { state.prefix = ''; }
      else { state.prefix = el.getAttribute('data-prefix') || ''; }
      state.tokenStack = [];
      state.nextToken = null;
      updateURL();
      loadListing();
    };
  });
}

function selectBucket(bucket) {
  state.bucket = bucket;
  state.prefix = '';
  state.tokenStack = [];
  state.nextToken = null;
  bucketActionsEl.classList.remove('hidden');
  // Switch from landing to listing
  if (landingEl) landingEl.classList.add('hidden');
  if (listingEl) listingEl.classList.remove('hidden');
  // Hide smart cleanup controls until we determine eligibility from listing
  updateSmartUIVisibility(false, false);
  updateURL();
  loadListing();
  startListingAutoRefresh();
  // Close sidebar on mobile after selecting a bucket
  closeSidebar();
}

function goHome() {
  state.bucket = null;
  state.prefix = '';
  state.tokenStack = [];
  state.nextToken = null;
  if (bucketTitleEl) bucketTitleEl.textContent = '';
  if (bucketActionsEl) bucketActionsEl.classList.add('hidden');
  if (landingEl) landingEl.classList.remove('hidden');
  if (listingEl) listingEl.classList.add('hidden');
  if (previewModal && !previewModal.classList.contains('hidden')) hidePreviewModal();
  setStatus('');
  stopListingAutoRefresh();
  history.pushState({}, '', '/');
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

// Legacy 30+ days cleanup removed

btnDeleteAll.onclick = async () => {
  if (!state.bucket) return;
  // Preview ALL files within current scope (bucket or prefix), similar to Smart cleanup
  setStatus('Preparing delete-all preview...');
  listingOverlay && listingOverlay.classList.remove('hidden');
  try {
    const candidates = await collectAllObjects(state.bucket, state.prefix);
    showPreview({ type: 'all', bucket: state.bucket, candidates, meta: { prefix: state.prefix } });
    // Override info line to reflect delete-all semantics
    if (typeof previewInfo !== 'undefined' && previewInfo) {
      const scope = state.prefix ? `Prefix "${state.prefix}"` : 'Entire bucket';
      previewInfo.textContent = `${scope} — ${candidates.length} files planned for deletion (all files)`;
    }
    setStatus('');
  } catch (e) {
    setStatus(`Error: ${e && e.message ? e.message : String(e)}`, true);
  } finally {
    listingOverlay && listingOverlay.classList.add('hidden');
  }
};

// Collect all objects recursively by traversing folders using the listing API
async function collectAllObjects(bucket, prefix) {
  const out = [];
  const seen = new Set();
  const queue = [prefix || ''];
  while (queue.length) {
    const cur = queue.shift();
    let token = null;
    let pages = 0; // safety
    while (true) {
      const params = new URLSearchParams();
      if (cur) params.set('prefix', cur);
      if (token) params.set('token', token);
      const res = await fetch(`/api/buckets/${encodeURIComponent(bucket)}/list?${params.toString()}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (Array.isArray(data.objects)) out.push(...data.objects);
      if (Array.isArray(data.folders)) {
        for (const f of data.folders) {
          if (!seen.has(f)) { seen.add(f); queue.push(f); }
        }
      }
      token = data.next_token || null;
      pages += 1;
      if (!token || pages > 100000) break;
    }
  }
  return out;
}

btnSmartCleanup.onclick = async () => {
  if (!state.bucket) return;
  setStatus('Preparing smart cleanup preview...');
  listingOverlay && listingOverlay.classList.remove('hidden');
  try {
    const params = new URLSearchParams();
    if (state.prefix) params.set('prefix', state.prefix);
    const res = await fetch(`/api/buckets/${encodeURIComponent(state.bucket)}/smart-cleanup-preview?${params.toString()}`);
    const data = await res.json();
    if (data.error) { setStatus(`Error: ${data.error}`, true); return; }
    setStatus('');
    showPreview({ type: 'smart', bucket: state.bucket, candidates: data.candidates, meta: { prefix: data.prefix, policy: data.policy, kept: data.kept, scanned: data.scanned } });
  } finally {
    listingOverlay && listingOverlay.classList.add('hidden');
  }
};

if (btnSmartCleanupFolders) {
  btnSmartCleanupFolders.onclick = async () => {
    if (!state.bucket) return;
    setStatus('Preparing folder smart cleanup preview...');
    listingOverlay && listingOverlay.classList.remove('hidden');
    try {
      const params = new URLSearchParams();
      if (state.prefix) params.set('prefix', state.prefix);
      const res = await fetch(`/api/buckets/${encodeURIComponent(state.bucket)}/smart-cleanup-folders-preview?${params.toString()}`);
      const data = await res.json();
      if (data.error) { setStatus(`Error: ${data.error}`, true); return; }
      setStatus('');
      showPreview({ type: 'smart-folders', bucket: state.bucket, candidates: data.candidates, meta: { prefix: data.prefix, policy: data.policy, kept: data.kept, scanned: data.scanned_folders } });
    } finally {
      listingOverlay && listingOverlay.classList.add('hidden');
    }
  };
}

function showPreview(preview) {
  state.preview = preview;
  // Render basic info
  const scope = preview.meta.prefix ? `Prefix "${preview.meta.prefix}"` : 'Entire bucket';
  const extra = (preview.type === 'smart' || preview.type === 'smart-folders') ? '(smart policy)' : '';
  previewInfo.textContent = `${scope} — ${preview.candidates.length} files planned for deletion ${extra}`;
  // Render list
  previewList.innerHTML = '';
  // Reset scroll to avoid any sticky header overlap quirks between sessions
  try { previewList.scrollTop = 0; } catch (_) {}
  // Header row for readability
  const head = document.createElement('div');
  head.className = 'preview-head';
  head.innerHTML = `<div></div><div>Path</div><div>Modified</div><div>Size</div>`;
  previewList.appendChild(head);
  const frag = document.createDocumentFragment();
  preview.candidates.forEach((c, idx) => {
    const row = document.createElement('div');
    row.className = 'preview-item';
    const rel = formatRelativeTime(c.last_modified);
    const exact = formatExactTimestamp(c.last_modified);
    const abs = formatLocalDate(c.last_modified);
    row.innerHTML = `
      <input type="checkbox" class="candidate" data-key="${encodeURIComponent(c.key)}" />
      <div class="path">${c.key}</div>
      <div class="muted date" title="${exact}">${rel || abs}</div>
      <div class="muted size">${fmtBytes(c.size)}</div>
    `;
    // Ensure checkbox is enabled and focusable (in case a previous run disabled it)
    const cb = row.querySelector('input.candidate');
    if (cb) { cb.disabled = false; cb.tabIndex = 0; }
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
  approveSelected.disabled = true;
  // Ensure controls are enabled for a fresh preview session
  if (selectAll) {
    selectAll.disabled = false;
    selectAll.checked = false;
  }
  if (deleteStopBtn) {
    deleteStopBtn.disabled = true;
    deleteStopBtn.onclick = null;
  }
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
  const chunkSize = 10;
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
if (homeLink) homeLink.onclick = (e) => { e.preventDefault(); goHome(); };

async function annotateSmartMarkers() {
  // Remove previous markers
  [...rowsEl.querySelectorAll('.smart-del')].forEach(el => el.remove());
  if (!state.bucket) return;
  const params = new URLSearchParams();
  if (state.prefix) params.set('prefix', state.prefix);
  // Objects (files) markers
  if (state.smartEligibleFiles) {
    try {
      const res = await fetch(`/api/buckets/${encodeURIComponent(state.bucket)}/smart-cleanup-preview?${params.toString()}`);
      const data = await res.json();
      if (!data.error) {
        const cand = Array.isArray(data.candidates) ? data.candidates : [];
        const delSet = new Set(cand.map(c => c.key));
        const reasons = new Map(cand.map(c => [c.key, c.policy_reason || (c.policy_tier && c.policy_bucket_id ? `Not newest for ${c.policy_tier} bucket ${c.policy_bucket_id}` : 'Will be removed by Smart cleanup')]));
        const rows = [...rowsEl.querySelectorAll('tr[data-key]')];
        rows.forEach(tr => {
          const key = tr.getAttribute('data-key');
          if (delSet.has(key)) {
            const td = tr.querySelector('td.name-cell');
            if (!td) return;
            const icon = document.createElement('span');
            icon.className = 'smart-del';
            icon.title = reasons.get(key) || 'Will be removed by Smart cleanup';
            icon.textContent = '🧹';
            td.appendChild(icon);
          }
        });
      }
    } catch (_) { /* ignore markers on error */ }
  }
  // Folders markers
  if (state.smartEligibleFolders) {
    try {
      const res2 = await fetch(`/api/buckets/${encodeURIComponent(state.bucket)}/smart-cleanup-folders-preview?${params.toString()}`);
      const data2 = await res2.json();
      if (!data2.error) {
        const cand2 = Array.isArray(data2.candidates) ? data2.candidates : [];
        const delPfx = new Set(cand2.map(c => c.key));
        const reasons2 = new Map(cand2.map(c => [c.key, c.policy_reason || (c.policy_tier && c.policy_bucket_id ? `Not newest for ${c.policy_tier} bucket ${c.policy_bucket_id}` : 'Folder will be removed by Smart cleanup')]));
        const frows = [...rowsEl.querySelectorAll('tr[data-prefix]')];
        frows.forEach(tr => {
          const pfx = tr.getAttribute('data-prefix');
          if (delPfx.has(pfx)) {
            const td = tr.querySelector('td.name-cell');
            if (!td) return;
            const icon = document.createElement('span');
            icon.className = 'smart-del';
            icon.title = reasons2.get(pfx) || 'Folder will be removed by Smart cleanup';
            icon.textContent = '🧹';
            td.appendChild(icon);
          }
        });
      }
    } catch (_) { /* ignore markers on error */ }
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
  // Reset preview controls to default state
  if (selectAll) { selectAll.disabled = false; selectAll.checked = false; }
  if (deleteStopBtn) {
    deleteStopBtn.disabled = true;
    deleteStopBtn.onclick = null;
  }
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
    bucketActionsEl.classList.remove('hidden');
    if (landingEl) landingEl.classList.add('hidden');
    if (listingEl) listingEl.classList.remove('hidden');
    updateSmartUIVisibility(false, false);
    loadListing();
    startListingAutoRefresh();
  } else {
    // No bucket in path: show landing
    state.bucket = null;
    state.prefix = '';
    if (bucketActionsEl) bucketActionsEl.classList.add('hidden');
    if (landingEl) landingEl.classList.remove('hidden');
    if (listingEl) listingEl.classList.add('hidden');
    stopListingAutoRefresh();
  }
});

// Initial path handling
const initial = parsePath();
if (initial && initial.bucket) {
  state.bucket = initial.bucket;
  state.prefix = initial.prefix || '';
  // reflect current without adding to history again
  updateURL(true);
  bucketActionsEl.classList.remove('hidden');
  if (landingEl) landingEl.classList.add('hidden');
  if (listingEl) listingEl.classList.remove('hidden');
  // Hide smart cleanup controls until eligibility is known for this view
  updateSmartUIVisibility(false, false);
  loadListing();
  startListingAutoRefresh();
} else {
  // Landing state initially
  if (landingEl) landingEl.classList.remove('hidden');
  if (listingEl) listingEl.classList.add('hidden');
  stopListingAutoRefresh();
}

// Manual refresh action
if (btnRefresh) btnRefresh.onclick = () => { if (state.bucket) loadListing(); };
