const bucketsEl = document.getElementById('buckets');
const rowsEl = document.getElementById('rows');
const statusEl = document.getElementById('status');
const bucketTitleEl = document.getElementById('bucket-title');
const bucketActionsEl = document.getElementById('bucket-actions');
const breadcrumbsEl = document.getElementById('breadcrumbs');
const btnCleanup = document.getElementById('btn-cleanup');
const btnDeleteAll = document.getElementById('btn-delete-all');
const btnPrev = document.getElementById('prev');
const btnNext = document.getElementById('next');

let state = {
  bucket: null,
  prefix: '',
  tokenStack: [], // for prev
  nextToken: null,
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

loadBuckets().catch(e => setStatus(String(e), true));

