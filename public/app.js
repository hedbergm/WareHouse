async function api(path, method='GET', body) {
  const opts = { method, headers: {} };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  return res.ok ? res.json() : Promise.reject(await res.json());
}

async function refresh() {
  const parts = await api('/api/parts').catch(()=>[]);
  const partsDiv = document.getElementById('parts');

  // Fetch stock details for each part (total + per-location)
  const partsWithStock = await Promise.all(parts.map(async (p) => {
    try {
      const stock = await api(`/api/stock/${encodeURIComponent(p.part_number)}`);
      return { part: p, stock };
    } catch (e) {
      return { part: p, stock: { total: 0, locations: [] } };
    }
  }));

  partsDiv.innerHTML = partsWithStock.map(({ part: p, stock }) => {
    const fixedInfo = p.default_location_id ? `<span class=\"fixed-loc-tag\">Fast: ${p.default_location_name || ''} (${p.default_location_barcode || ''})</span>` : '';
    return `
  <div class="part-row" data-id="${p.id}">
      <div class="part-left">
        <strong>${p.part_number}</strong>
        <div class="desc">${p.description || ''}</div>
    <div class="meta">Min: ${p.min_qty} · Totalt: ${stock.total} ${fixedInfo}</div>
        <div class="locs">
          ${stock.locations && stock.locations.length ? stock.locations.map(l => `
            <div class="loc-item">${l.location_name} (${l.barcode}) — <strong>${l.qty}</strong></div>
          `).join('') : '<div class="loc-item muted">Ingen lokasjoner registrert</div>'}
        </div>
      </div>
      <div class="part-right">
        <img src="/api/parts/${encodeURIComponent(p.part_number)}/barcode.png" alt="barcode">
        <div style="margin-top:8px;display:flex;gap:6px">
          <button class="edit-part btn small" data-id="${p.id}">Endre</button>
          <button class="delete-part btn small danger" data-id="${p.id}">Slett</button>
        </div>
      </div>
    </div>
  `; }).join('');

  // attach handlers
  document.querySelectorAll('.delete-part').forEach(b => b.addEventListener('click', async (e) => {
    const id = e.currentTarget.dataset.id;
    if (!confirm('Slette denne delen?')) return;
    await api(`/api/parts/${id}`, 'DELETE').catch(err => alert(JSON.stringify(err)));
    await refresh();
  }));
  document.querySelectorAll('.edit-part').forEach(b => b.addEventListener('click', async (e) => {
  const id = e.currentTarget.dataset.id;
  const row = e.currentTarget.closest('.part-row');
  const pn = prompt('Nytt delenummer', row.querySelector('strong').innerText) || '';
  const desc = prompt('Ny beskrivelse', row.querySelector('.desc').innerText) || '';
  const minq = prompt('Ny min antall', '0');
  const defLoc = prompt('Fast lokasjon barcode (tom for ingen)', '');
  await api(`/api/parts/${id}`, 'PUT', { part_number: pn.trim(), description: desc.trim(), min_qty: parseInt(minq || '0', 10), default_location_barcode: defLoc ? defLoc.trim() : undefined }).catch(err => alert(JSON.stringify(err)));
  await refresh();
  }));

  const locs = await api('/api/locations').catch(()=>[]);
  const locDiv = document.getElementById('locations');
  // Populate dropdown for fixed location selection
  const ddl = document.getElementById('part-default-loc');
  if (ddl) {
    const current = ddl.value; // preserve selection if possible
    ddl.innerHTML = '<option value="">(Ingen fast lokasjon)</option>' + locs.map(l => `<option value="${l.barcode}">${l.name} (${l.barcode})</option>`).join('');
    if (current && [...ddl.options].some(o => o.value === current)) ddl.value = current;
  }
  locDiv.innerHTML = '<p style="margin:4px 0 10px"><a href="/location-barcodes.html" class="muted-link" style="font-size:12px">Utskrift av alle strekkoder →</a></p>' +
    locs.map(l => `
    <div class="loc-row" data-id="${l.id}">
      <div class="loc-left" style="display:flex;align-items:center;gap:10px">
        <img src="/api/locations/${l.id}/barcode.png" alt="${l.barcode}" style="height:46px;background:#fff;padding:4px;border:1px solid #eee;border-radius:4px">
        <div>
          <div><strong>${l.name}</strong></div>
          <div style="font-size:11px;color:#666">${l.barcode}</div>
        </div>
      </div>
      <div class="loc-right">
        <button class="edit-loc btn small" data-id="${l.id}">Endre</button>
        <button class="delete-loc btn small danger" data-id="${l.id}">Slett</button>
      </div>
    </div>
  `).join('');

  document.querySelectorAll('.delete-loc').forEach(b => b.addEventListener('click', async (e) => {
    const id = e.currentTarget.dataset.id;
    if (!confirm('Slette denne lokasjonen? Dette fjerner også tilhørende beholdning.')) return;
    await api(`/api/locations/${id}`, 'DELETE').catch(err => alert(JSON.stringify(err)));
    await refresh();
  }));
  document.querySelectorAll('.edit-loc').forEach(b => b.addEventListener('click', async (e) => {
    const id = e.currentTarget.dataset.id;
    const name = prompt('Nytt navn', '') || '';
    const barcode = prompt('Ny barcode', '') || '';
    if (!name || !barcode) return alert('Navn og barcode kreves');
    await api(`/api/locations/${id}`, 'PUT', { name: name.trim(), barcode: barcode.trim() }).catch(err => alert(JSON.stringify(err)));
    await refresh();
  }));

  // Oppdater transaksjonslogg etter at deler/lokasjoner er endret
  await refreshLog(false);
}

// Dynamic injection fallback no longer needed (dropdown shipped in HTML)

document.getElementById('add-loc').addEventListener('click', async () => {
  const name = document.getElementById('loc-name').value.trim();
  const barcode = document.getElementById('loc-barcode').value.trim();
  if (!name || !barcode) return alert('navn og barcode kreves');
  await api('/api/locations', 'POST', { name, barcode }).catch(e => alert(JSON.stringify(e)));
  document.getElementById('loc-name').value=''; document.getElementById('loc-barcode').value='';
  await refresh();
});

document.getElementById('add-part').addEventListener('click', async () => {
  const part_number = document.getElementById('part-number').value.trim();
  const description = document.getElementById('part-desc').value.trim();
  const min_qty = parseInt(document.getElementById('part-min').value || '0', 10);
  const default_location_barcode = (document.getElementById('part-default-loc') || { value: '' }).value.trim();
  if (!part_number) return alert('delenummer kreves');
  await api('/api/parts', 'POST', { part_number, description, min_qty, default_location_barcode: default_location_barcode || undefined }).catch(e => alert(JSON.stringify(e)));
  document.getElementById('part-number').value=''; document.getElementById('part-desc').value=''; document.getElementById('part-min').value=''; if (document.getElementById('part-default-loc')) document.getElementById('part-default-loc').value='';
  await refresh();
});

// (Live barcode preview while typing removed per request)

// Scan-knapper finnes ikke lenger etter at manuell skann ble fjernet – guard så scriptet ikke krasjer
const btnScanIn = document.getElementById('scan-in');
if (btnScanIn) btnScanIn.addEventListener('click', async () => { await doScan('in'); });
const btnScanOut = document.getElementById('scan-out');
if (btnScanOut) btnScanOut.addEventListener('click', async () => { await doScan('out'); });

async function doScan(action) {
  const location_barcode = document.getElementById('scan-location').value.trim();
  const part_number = document.getElementById('scan-part').value.trim();
  const qty = parseInt(document.getElementById('scan-qty').value || '0', 10);
  if (!location_barcode || !part_number || !qty) return alert('lokasjon, del og antall kreves');
  try {
    const r = await api('/api/stock/scan', 'POST', { location_barcode, part_number, qty, action });
    document.getElementById('scan-result').innerText = 'OK';
    await refresh();
  } catch (e) {
    document.getElementById('scan-result').innerText = JSON.stringify(e);
  }
}

refresh();

// --- Transaksjonslogg ---
let logTimer = null;
async function refreshLog(showLoading=true){
  const partF = document.getElementById('log-filter-part');
  const locF = document.getElementById('log-filter-loc');
  const limitSel = document.getElementById('log-limit');
  const out = document.getElementById('tx-log');
  if(!out) return; // section not present
  const params = new URLSearchParams();
  if(partF && partF.value.trim()) params.set('part', partF.value.trim());
  if(locF && locF.value.trim()) params.set('loc', locF.value.trim());
  if(limitSel) params.set('limit', limitSel.value);
  if(showLoading) out.innerHTML='<div style="padding:8px;font-size:12px;color:#555">Laster…</div>';
  try {
    const rows = await api('/api/transactions?'+params.toString());
    if(!rows.length){ out.innerHTML='<div style="padding:8px;font-size:12px;color:#777">Ingen transaksjoner</div>'; return; }
    out.innerHTML = rows.map(r => {
      const ts = r.created_at ? r.created_at.replace('T',' ').substring(0,19) : '';
      const dir = r.action === 'in' ? '<span style="color:#14763d;font-weight:600">+ '+r.qty+'</span>' : '<span style="color:#b32020;font-weight:600">- '+r.qty+'</span>';
      return `<div style="display:flex;flex-direction:column;padding:6px 10px;border-top:1px solid #f1f1f1;font-size:12px">
        <div style="display:flex;justify-content:space-between;gap:8px"><strong>${r.part_number}</strong><span>${ts}</span></div>
        <div style="display:flex;justify-content:space-between;gap:8px">${dir}<span>${r.location_name||''} (${r.location_barcode})</span></div>
        <div style="color:#555">${r.description||''}</div>
      </div>`;
    }).join('');
  } catch(e){ out.innerHTML='<div style="padding:8px;font-size:12px;color:#c00">Feil: '+(e.error||'')+'</div>'; }
}

const logRefreshBtn = document.getElementById('log-refresh');
if(logRefreshBtn){ logRefreshBtn.addEventListener('click', ()=> refreshLog(true)); }
['log-filter-part','log-filter-loc','log-limit'].forEach(id => {
  const el = document.getElementById(id); if(el){ el.addEventListener('input', ()=> { clearTimeout(logTimer); logTimer=setTimeout(()=> refreshLog(true), 400); }); }
});

// Initial load av logg
refreshLog(true);
