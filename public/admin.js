const $ = (sel, el=document) => el.querySelector(sel);
const $$ = (sel, el=document) => Array.from(el.querySelectorAll(sel));
const fmt = {
  km: v => v==null ? '—' : Intl.NumberFormat().format(v)+' km',
  date: iso => iso ? new Date(iso).toLocaleString() : '—'
};

const ingestBtn = $('#ingest');
const pdfInp   = $('#pdf');
const lotInp   = $('#lot');
const siteInp  = $('#site');
const ingestOut= $('#ingest-out');
const rowsEl   = $('#rows');
const refreshBtn = $('#refresh');
const autoRefChk = $('#autoref');

let timer;

refreshBtn.addEventListener('click', loadList);
autoRefChk.addEventListener('change', () => {
  if (autoRefChk.checked) {
    timer = setInterval(loadList, 5000);
  } else {
    clearInterval(timer); timer = null;
  }
});

ingestBtn.addEventListener('click', async () => {
  const file = pdfInp.files?.[0];
  if (!file) { ingestOut.textContent = 'Pick a PDF first.'; return; }
  ingestBtn.disabled = true; ingestOut.textContent = 'Uploading…';
  try {
    const fd = new FormData();
    fd.append('pdf', file);
    if (lotInp.value) fd.append('lot_id', lotInp.value);
    if (siteInp.value) fd.append('site_hint', siteInp.value);
    const res = await fetch('/ingest/dekra', { method:'POST', body: fd });
    const json = await res.json();
    if (!res.ok) throw new Error(json?.error || res.statusText);
    ingestOut.textContent = `OK → VIN ${json.record?.vin || json?.draft?.vin || '(unknown)'} (coverage ${json.coverage})`;
    pdfInp.value = ''; loadList();
  } catch (e) {
    ingestOut.textContent = 'Error: ' + e.message;
  } finally {
    ingestBtn.disabled = false;
  }
});

async function loadList() {
  rowsEl.innerHTML = `<tr><td colspan="7" class="mut">Loading…</td></tr>`;
  try {
    const res = await fetch('/passports');
    const list = await res.json();
    if (!Array.isArray(list) || !list.length) {
      rowsEl.innerHTML = `<tr><td colspan="7" class="mut">No records yet.</td></tr>`;
      return;
    }
    rowsEl.innerHTML = '';
    list.forEach(rec => rowsEl.appendChild(renderRow(rec)));
  } catch (e) {
    rowsEl.innerHTML = `<tr><td colspan="7" class="mut">Failed to load: ${e.message}</td></tr>`;
  }
}

function renderRow(rec) {
  const tr = document.createElement('tr');
  const model = rec.sealed || rec.draft || {};
  const km = model?.odometer?.km ?? null;
  const insp = model?.dekra?.inspection_ts || null;
  const status = rec.sealed
    ? `<span class="pill green">Sealed</span>`
    : (rec.draft ? `<span class="pill amber">Draft</span>` : `<span class="pill">Empty</span>`);
  tr.innerHTML = `
    <td class="mono">${esc(rec.vin)}</td>
    <td>${esc(model?.lot_id || rec?.lot_id || '—')}</td>
    <td>${fmt.km(km)}</td>
    <td>${fmt.date(insp)}</td>
    <td>${status}</td>
    <td class="tiny mut">${fmt.date(rec.updatedAt)}</td>
    <td class="actions">
      <button class="primary" data-seal>Seal</button>
      <button data-verify>Verify</button>
      <button data-reingest>Re-ingest</button>
      <input type="file" data-reingest-file accept="application/pdf" style="display:none" />
      <button data-view-d>Draft</button>
      <button data-view-s>Sealed</button>
      <button data-del>Delete</button>
    </td>
  `;

  $('button[data-seal]', tr).addEventListener('click', () => seal(rec.vin, tr));
  $('button[data-verify]', tr).addEventListener('click', () => verify(rec.vin, tr));
  $('button[data-view-d]', tr).addEventListener('click', () => viewJson(rec.vin, 'draft'));
  $('button[data-view-s]', tr).addEventListener('click', () => viewJson(rec.vin, 'sealed'));
  $('button[data-del]', tr).addEventListener('click', () => del(rec.vin));

  // Re-ingest wiring
  $('button[data-reingest]', tr).addEventListener('click', () => {
    $('input[data-reingest-file]', tr).click();
  });
  $('input[data-reingest-file]', tr).addEventListener('change', (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    reIngest(rec.vin, file, tr);
    ev.target.value = ''; // reset input
  });

  return tr;
}

// --- row actions ---

async function seal(vin, tr){
  const btn = $('button[data-seal]', tr);
  btn.disabled = true; btn.textContent = 'Sealing…';
  try {
    const res = await fetch('/passports/seal', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ vin })
    });
    const j = await res.json();
    if(!res.ok) throw new Error(j?.error || res.statusText);
    btn.textContent = 'Sealed ✓';
    setTimeout(loadList, 300);
  } catch(e){
    btn.textContent = 'Seal';
    alert('Seal failed: ' + e.message);
  } finally { btn.disabled = false; }
}

async function verify(vin, tr){
  const btn = $('button[data-verify]', tr);
  btn.disabled = true; btn.textContent = 'Verifying…';
  try{
    const res = await fetch(`/verify?vin=${encodeURIComponent(vin)}`);
    const j = await res.json();
    btn.textContent = j.valid ? 'Valid ✓' : 'Invalid ✕';
    btn.classList.toggle('ok', !!j.valid);
    btn.classList.toggle('bad', !j.valid);
  }catch(e){
    btn.textContent = 'Verify';
    alert('Verify error: ' + e.message);
  }finally{ btn.disabled = false; }
}

async function del(vin){
  if(!confirm(`Delete ${vin}?`)) return;
  await fetch(`/passports/${encodeURIComponent(vin)}`, { method:'DELETE' });
  loadList();
}

async function viewJson(vin, kind){
  const res = await fetch(`/passports/${encodeURIComponent(vin)}`);
  const rec = await res.json();
  const obj = kind === 'sealed' ? rec.sealed : rec.draft;
  const win = window.open('', '_blank');
  win.document.write(`<pre>${esc(JSON.stringify(obj || {note:`No ${kind}`}, null, 2))}</pre>`);
  win.document.close();
}

async function reIngest(vin, file, tr){
  const btn = $('button[data-reingest]', tr);
  btn.disabled = true; btn.textContent = 'Re-ingesting…';
  try{
    const fd = new FormData();
    fd.append('pdf', file);
    fd.append('expected_vin', vin); // server will 409 if VIN mismatches
    const res = await fetch('/ingest/dekra', { method:'POST', body: fd });
    const j = await res.json();

    if (res.status === 409 && j?.error === 'vin_mismatch') {
      alert(`VIN mismatch:\n  expected: ${j.expectedVin}\n  parsed:   ${j.parsedVin}\nAborting replace.`);
      return;
    }
    if (!res.ok) throw new Error(j?.error || res.statusText);

    btn.textContent = 'Re-ingested ✓';
    setTimeout(loadList, 300);
  } catch(e){
    btn.textContent = 'Re-ingest';
    alert('Re-ingest failed: ' + e.message);
  } finally {
    btn.disabled = false;
  }
}

// --- utils ---

function esc(s){ return (s??'').toString().replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// initial load
loadList();
