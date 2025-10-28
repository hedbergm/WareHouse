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
  // Desktop Edit modal wiring
  const edModal = document.getElementById('edit-modal');
  const edClose = document.getElementById('ed-close');
  const edCancel = document.getElementById('ed-cancel');
  const edSave = document.getElementById('ed-save');
  const edMsg = document.getElementById('ed-msg');
  const edPart = document.getElementById('ed-part');
  const edDesc = document.getElementById('ed-desc');
  const edMin = document.getElementById('ed-min');
  const edMinInc = document.getElementById('ed-min-inc');
  const edMinDec = document.getElementById('ed-min-dec');
  const edFixedSel = document.getElementById('ed-fixed-select');
  const edClearFixed = document.getElementById('ed-clear-fixed');
  const edStockLoc = document.getElementById('ed-stock-loc');
  const edQty = document.getElementById('ed-qty');

  function openEdit(){ if(edModal) edModal.classList.remove('hidden'); }
  function closeEdit(){ if(edModal) edModal.classList.add('hidden'); if(edMsg) edMsg.textContent=''; }
  if(edClose) edClose.addEventListener('click', closeEdit);
  if(edCancel) edCancel.addEventListener('click', closeEdit);
  if(edMinInc) edMinInc.addEventListener('click', ()=> { const v=parseInt(edMin.value||'0',10)||0; edMin.value=String(Math.max(0, v+1)); });
  if(edMinDec) edMinDec.addEventListener('click', ()=> { const v=parseInt(edMin.value||'0',10)||0; edMin.value=String(Math.max(0, v-1)); });

  // populate selects with locations
  const locs = await api('/api/locations').catch(()=>[]);
  function fillLocSelect(sel, includeNone=true){ if(!sel) return; sel.innerHTML = (includeNone? '<option value="">(Velg lokasjon)</option>':'' ) + locs.map(l=> `<option value="${l.barcode}">${l.name} (${l.barcode})</option>`).join(''); }
  fillLocSelect(edFixedSel, true);
  fillLocSelect(edStockLoc, true);

  document.querySelectorAll('.edit-part').forEach(b => b.addEventListener('click', async (e) => {
    try{
      const id = e.currentTarget.dataset.id;
      const part = (await api('/api/parts')).find(p=> String(p.id)===String(id));
      if(!part) return alert('Fant ikke del');
      const stock = await api(`/api/stock/${encodeURIComponent(part.part_number)}`);
      // prime fields
      edPart.value = part.part_number || '';
      edDesc.value = part.description || '';
      edMin.value = String(part.min_qty || 0);
      // fixed select
      fillLocSelect(edFixedSel, true);
      if(part.default_location_barcode){ edFixedSel.value = part.default_location_barcode; }
      else { edFixedSel.value = ''; }
      // stock loc default to fixed if exists
      fillLocSelect(edStockLoc, true);
      if(part.default_location_barcode){ edStockLoc.value = part.default_location_barcode; }
      else { edStockLoc.value=''; }
      // preset qty if a location chosen and known
      if(edStockLoc.value){ const locRow = (stock.locations||[]).find(l=> l.barcode===edStockLoc.value); edQty.value = String(Math.max(0, parseInt((locRow && locRow.qty)||'0',10)||0)); } else { edQty.value='0'; }
      openEdit();
      // bind save for this part id
      edSave.onclick = async ()=>{
        try{
          edSave.disabled=true; edMsg.textContent='';
          const pn = edPart.value.trim(); const desc = edDesc.value.trim(); const minq = parseInt(edMin.value||'0',10)||0;
          const fixedBarcode = edFixedSel.value || undefined; // undefined clears on server
          await api(`/api/parts/${id}`, 'PUT', { part_number: pn, description: desc, min_qty: minq, default_location_barcode: fixedBarcode });
          const stockLoc = edStockLoc.value; const qtyVal = Math.max(0, parseInt(edQty.value||'0',10)||0);
          if(stockLoc){ await api('/api/stock/set','POST',{ part_number: pn, location_barcode: stockLoc, qty: qtyVal }); }
          edMsg.textContent='Lagret';
          closeEdit();
          await refresh();
        } catch(err){ edMsg.textContent = 'Feil: '+(err.error||err.message||err); }
        finally{ edSave.disabled=false; }
      };
      if(edClearFixed){ edClearFixed.onclick = ()=> { edFixedSel.value=''; } }
      if(edStockLoc){ edStockLoc.onchange = ()=> { const sel=edStockLoc.value; const locRow = (stock.locations||[]).find(l=> l.barcode===sel); edQty.value = String(Math.max(0, parseInt((locRow && locRow.qty)||'0',10)||0)); }; }
    } catch(err){ alert('Feil ved lasting: '+(err.error||err.message||err)); }
  }));

  // Populate dropdown for fixed location selection only
  const ddl = document.getElementById('part-default-loc');
  if (ddl) {
    const current = ddl.value;
    ddl.innerHTML = '<option value="">(Ingen fast lokasjon)</option>' + (locs||[]).map(l => `<option value="${l.barcode}">${l.name} (${l.barcode})</option>`).join('');
    if (current && [...ddl.options].some(o => o.value === current)) ddl.value = current;
  }

  // Oppdater transaksjonslogg etter at deler/lokasjoner er endret
  await refreshLog(false);
}

// Dynamic injection fallback no longer needed (dropdown shipped in HTML)

// Lokasjons-CRUD fjernet fra denne siden

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
  const userF = document.getElementById('log-filter-user');
  const limitSel = document.getElementById('log-limit');
  const out = document.getElementById('tx-log');
  if(!out) return; // section not present
  const params = new URLSearchParams();
  if(partF && partF.value.trim()) params.set('part', partF.value.trim());
  if(locF && locF.value.trim()) params.set('loc', locF.value.trim());
  if(userF && userF.value.trim()) params.set('user', userF.value.trim());
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
  <div style="display:flex;justify-content:space-between;gap:8px;color:#444"><span style="font-size:11px">${r.username ? 'Bruker: '+r.username : ''}</span></div>
        <div style="color:#555">${r.description||''}</div>
      </div>`;
    }).join('');
  } catch(e){ out.innerHTML='<div style="padding:8px;font-size:12px;color:#c00">Feil: '+(e.error||'')+'</div>'; }
}

const logRefreshBtn = document.getElementById('log-refresh');
if(logRefreshBtn){ logRefreshBtn.addEventListener('click', ()=> refreshLog(true)); }
['log-filter-part','log-filter-loc','log-filter-user','log-limit'].forEach(id => {
  const el = document.getElementById(id); if(el){ el.addEventListener('input', ()=> { clearTimeout(logTimer); logTimer=setTimeout(()=> refreshLog(true), 400); }); }
});

// Initial load av logg
refreshLog(true);
