const bucketsEl = document.getElementById('buckets');
const rowsEl = document.getElementById('rows');
const statusEl = document.getElementById('status');
const bucketTitleEl = document.getElementById('bucket-title');
const bucketActionsEl = document.getElementById('bucket-actions');
const breadcrumbsEl = document.getElementById('breadcrumbs');
const btnCleanup = document.getElementById('btn-cleanup');
const btnDeleteAll = document.getElementById('btn-delete-all');
const btnSmartCleanup = document.getElementById('btn-smart-cleanup');
const btnPrev = document.getElementById('prev');
const btnNext = document.getElementById('next');
const themeToggle = document.getElementById('theme-toggle');

let state = {
  bucket: null,
  prefix: '',
  tokenStack: [], // for prev
  nextToken: null,
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
  themeToggle.textContent = `Theme: ${mode.charAt(0).toUpperCase() + mode.slice(1)}`;
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
  const res = await fetch('/api/buckets');
  const data = await res.json();
  bucketsEl.innerHTML = '';
  data.buckets.forEach(b => {
    const li = document.createElement('li');
    li.textContent = b;
    li.onclick = () => selectBucket(b);
    bucketsEl.appendChild(li);
  });
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
      loadListing();
    };
  });
}

async function loadListing(token) {
  if (!state.bucket) return;
  setStatus('');
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
    tr.innerHTML = `<td><span class="link">📁 ${name}</span></td><td></td><td></td>`;
    tr.querySelector('.link').onclick = () => {
      state.prefix = f; state.tokenStack = []; state.nextToken = null; loadListing();
    };
    rowsEl.appendChild(tr);
  });
  // objects
  data.objects.forEach(o => {
    const name = o.key.replace(state.prefix, '');
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${name}</td><td>${fmtBytes(o.size)}</td><td>${o.last_modified || ''}</td>`;
    rowsEl.appendChild(tr);
  });
  state.nextToken = data.next_token || null;
  btnNext.disabled = !state.nextToken;
  btnPrev.disabled = state.tokenStack.length === 0;
  renderBreadcrumbs();
}

function selectBucket(bucket) {
  state.bucket = bucket;
  state.prefix = '';
  state.tokenStack = [];
  state.nextToken = null;
  bucketTitleEl.textContent = bucket;
  bucketActionsEl.classList.remove('hidden');
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
  if (!confirm(`Cleanup objects older than 30 days in ${state.bucket}?`)) return;
  setStatus('Starting cleanup...');
  const res = await fetch(`/api/buckets/${encodeURIComponent(state.bucket)}/cleanup`, { method: 'POST' });
  const data = await res.json();
  if (data.error) setStatus(`Error: ${data.error}`, true);
  else setStatus(`Cleanup done. Deleted ${data.deleted} (scanned ${data.scanned}).`);
  await loadListing();
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
  const scope = state.prefix ? `prefix "${state.prefix}"` : 'entire bucket';
  const msg = `Smart cleanup on ${scope} in ${state.bucket}?\n\nPolicy:\n- < 7 days: keep 1 per hour\n- 7–30 days: keep 1 per day\n- 30–90 days: keep 1 per 7 days\n- 90–365 days: keep 1 per 2 weeks\n- >= 365 days: keep 1 per month\n\nProceed?`;
  if (!confirm(msg)) return;
  setStatus('Running smart cleanup...');
  const params = new URLSearchParams();
  if (state.prefix) params.set('prefix', state.prefix);
  const res = await fetch(`/api/buckets/${encodeURIComponent(state.bucket)}/smart-cleanup?${params.toString()}`, { method: 'POST' });
  const data = await res.json();
  if (data.error) {
    setStatus(`Error: ${data.error}`, true);
    return;
  }
  setStatus(`Smart cleanup done. Kept ${data.kept}/${data.scanned}, deleted ${data.deleted} (planned ${data.to_delete}).`);
  await loadListing();
};

loadBuckets().catch(e => setStatus(String(e), true));

// Initialize theme after DOM is ready
initTheme();
