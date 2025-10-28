async function api(path, method='GET', body) {
  const opts = { method, headers: {} };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(path, opts);
  return res.ok ? res.json() : Promise.reject(await res.json());
}

// Kamera/Quagga er fjernet – kun HW/WS skann brukes

// Login removed
const mainScreen = document.getElementById('main-screen');
// Lokasjonshåndtering fjernet (fast lokasjon per del)
const lastScan = document.getElementById('last-scan');
const movementPanel = document.getElementById('movement-panel');
const mvPart = document.getElementById('mv-part');
const mvQty = document.getElementById('mv-qty');
const mvAction = document.getElementById('mv-action');
const mvSubmit = document.getElementById('mv-submit');
const mvCancel = document.getElementById('mv-cancel');
const mvMessage = document.getElementById('mv-message');
const mvInfo = document.getElementById('mv-info');
const openEditBtn = document.getElementById('open-edit');
const locBanner = document.getElementById('loc-banner');
const locCodeEl = document.getElementById('loc-code');
const clearLocBtn = document.getElementById('clear-loc');
const mvLocHint = document.getElementById('mv-loc-hint');
const debugBtn = document.getElementById('toggle-debug');
const debugLog = document.getElementById('debug-log');
const qtyIncBtn = document.getElementById('qty-inc');
const qtyDecBtn = document.getElementById('qty-dec');
// Foto/test-kamera fjernet

// Bevegelsesmodus: tving INN eller UT hvis hash inneholder mode=in / mode=out
function resolveMovementMode(){
  const h = (location.hash||'').toLowerCase();
  if(h.includes('mode=out')) return 'out';
  if(h.includes('mode=in')) return 'in';
  return null;
}
let movementMode = resolveMovementMode();
window.addEventListener('hashchange', ()=> {
  movementMode = resolveMovementMode();
  // Hvis panel er åpent, oppdater valgt og disable state
  if(!movementPanel.classList.contains('hidden')){
    if(movementMode){ mvAction.value = movementMode; mvAction.disabled = true; }
    else { mvAction.disabled = false; }
    // oppdater hint for lokasjon
    updateLocHint();
  }
if(mvQty){

function dlog(msg){
    mvQty.setAttribute('inputmode','none');
    mvQty.setAttribute('pattern','[0-9]*');
    mvQty.setAttribute('enterkeyhint','done');
    mvQty.setAttribute('autocomplete','off');
    mvQty.readOnly = true; // ikke åpne mykt tastatur
  debugBtn.addEventListener('click', ()=> {
    if(debugLog.style.display==='none'){ debugLog.style.display='block'; debugBtn.textContent='Skjul debug'; }
    else { debugLog.style.display='none'; debugBtn.textContent='Debug'; }
  });
}


// Kamera-funksjoner fjernet

let scanMode = 'part'; // stabil modus – vi skanner kun deler via HW/WS
let currentLocationBarcode = null; // valgt lokasjon ved scanning
let currentPartHasFixed = null; // om valgt del har fast lokasjon
let currentPartData = null; // sist lastet delinfo

function updateLocBanner(){
  if(currentLocationBarcode){
    if(locCodeEl) locCodeEl.textContent = currentLocationBarcode;
    if(locBanner) locBanner.style.display = 'block';
  } else {
    if(locBanner) locBanner.style.display = 'none';
    if(locCodeEl) locCodeEl.textContent = '';
  }
}
function setCurrentLocation(barcode){
  currentLocationBarcode = barcode || null;
  updateLocBanner();
  if(barcode){
    lastScan.innerText = 'Lokasjon: '+barcode;
    dlog && dlog('Valgt lokasjon: '+barcode);
  }
}
if(clearLocBtn){
  clearLocBtn.addEventListener('click', ()=> { setCurrentLocation(null); });
}

async function isLocationBarcode(code){
  try {
    const res = await fetch('/api/locations/'+encodeURIComponent(code)+'/stock');
    if(res.status===401){
      // ikke innlogget
      try { window.location.href = '/mobile-login.html'; } catch(_){}
      return false;
    }
    return res.ok;
  } catch(_){ return false; }
}

async function handleScan(code, src){
  lastScan.innerText = 'Del: '+code + (src? ' ['+src.toUpperCase()+']':'' );
  mvPart.value = code;
  mvQty.value = 1;
  if(movementMode){
    mvAction.value = movementMode;
    mvAction.disabled = true;
  } else {
    mvAction.value = 'in';
    mvAction.disabled = false;
  }
  movementPanel.classList.remove('hidden');
  mvMessage.textContent = '';
  mvInfo.style.display='none'; mvInfo.textContent='';
  // Ikke auto-fokus på antall (for å unngå mykt tastatur før bruker ønsker det)
  // Bruker kan trykke i feltet for å få tastatur. Vi beholder verdi=1 som start.
  // Hent delinfo (lager + min + beskrivelse)
  dlog && dlog('Henter info for '+code);
  try {
    const data = await api('/api/stock/'+encodeURIComponent(code));
    dlog && dlog('Info lastet OK for '+code);
    currentPartData = data;
    const part = data.part || {}; const total = data.total || 0;
    currentPartHasFixed = !!(part && part.default_location_id);
    updateLocHint();
    const minq = part.min_qty ?? 0;
    const desc = part.description || '';
    const diff = total - minq;
    const locLines = (data.locations||[]).map(l=> `${l.location_name||''} (${l.barcode}) ${l.qty}`).join(' · ');
    const warn = total <= minq;
    if(warn){
      mvInfo.style.background = '#fff2f2';
      mvInfo.style.borderColor = '#f5b5b5';
      mvInfo.style.color = '#7d1d1d';
    } else {
      mvInfo.style.background = '#f4f8fc';
      mvInfo.style.borderColor = '#e2e6ec';
      mvInfo.style.color = '#222';
    }
    const statusLine = `Totalt: <strong>${total}</strong>  Min: <strong>${minq}</strong>  Diff: <strong>${diff>=0? '+'+diff: diff}</strong>`;
    mvInfo.innerHTML = `<strong>${part.part_number||code}</strong>${desc? ' – '+desc:''}<br>${statusLine}${locLines? '<br>'+locLines:''}`;
    mvInfo.style.display='block';
  } catch(e){
    dlog && dlog('Info LAST FEIL for '+code+': '+(e.error||e.message||e));
    mvInfo.style.display='block'; mvInfo.innerHTML='<span style="color:#c00">Fant ikke del i systemet (opprettes ved lagring om deler lages et annet sted)</span>';
  }
}
function updateLocHint(){
  if(!mvLocHint) return;
  const act = movementMode || mvAction.value || 'in';
  if(!currentPartHasFixed && act==='in') { mvLocHint.style.display='block'; }
  else { mvLocHint.style.display='none'; }
}
if(mvAction){ mvAction.addEventListener('change', updateLocHint); }

// handle manual add
// Manuell del-knapp fjernet

mvCancel.addEventListener('click', ()=> { movementPanel.classList.add('hidden'); });
mvSubmit.addEventListener('click', async () => {
  const part = mvPart.value.trim();
  const qty = parseInt(mvQty.value||'0',10);
  const action = movementMode || mvAction.value; // tvang om satt
  if(!part || !qty){ mvMessage.textContent='Mangler felt'; return; }
  // Hvis INN for del uten fast lokasjon, krever vi valgt lokasjon først
  if(action==='in' && currentPartHasFixed===false && !currentLocationBarcode){
    mvMessage.textContent = 'Denne delen mangler fast lokasjon. Skann lokasjon først (scan lokasjonsstrekkoden).';
    return;
  }
  mvSubmit.disabled=true;
  try {
  const payload = { part_number: part, qty, action };
  if(action==='in' && currentPartHasFixed===false && currentLocationBarcode){
    payload.location_barcode = currentLocationBarcode;
  }
  await api('/api/stock/scan','POST', payload);
  mvMessage.textContent='Lagret'; movementPanel.classList.add('hidden');
  } catch(e){ mvMessage.textContent='Feil: '+ (e.error||''); }
  finally { mvSubmit.disabled=false; }
});

// loadLocationContents removed (fast lokasjon håndteres server-side)

// +/- knapper for antall
if(qtyIncBtn){ qtyIncBtn.addEventListener('click', ()=> { const v=parseInt(mvQty.value||'0',10)||0; mvQty.value = String(Math.max(1, v+1)); }); }
if(qtyDecBtn){ qtyDecBtn.addEventListener('click', ()=> { const v=parseInt(mvQty.value||'0',10)||0; mvQty.value = String(Math.max(1, v-1)); }); }

// Enter i antall-feltet lagrer direkte; tillat også +/- på fysisk tastatur
if(mvQty){
  // Vis talltastatur og aksepter kun sifre
  try {
    mvQty.setAttribute('inputmode','numeric');
    mvQty.setAttribute('pattern','[0-9]*');
    mvQty.setAttribute('enterkeyhint','done');
    mvQty.setAttribute('autocomplete','off');
  } catch(_){}
  // Filtrer input til bare 0-9, og sørg for minst 1 ved blur
  mvQty.addEventListener('beforeinput', (e)=>{
    if(e.inputType === 'insertFromPaste'){
      const t = (e.data || (e.clipboardData && e.clipboardData.getData && e.clipboardData.getData('text')) || '').replace(/\D+/g,'');
      if(!t){ e.preventDefault(); return; }
    }
  });
  mvQty.addEventListener('input', ()=>{
    const digits = (mvQty.value||'').replace(/\D+/g,'');
    if(mvQty.value !== digits) mvQty.value = digits;
  });
  mvQty.addEventListener('blur', ()=>{
    const v = parseInt(mvQty.value||'0',10) || 0;
    mvQty.value = String(Math.max(1, v));
  });
  mvQty.addEventListener('keydown', (e)=> {
    if(e.key==='Enter'){ e.preventDefault(); mvSubmit.click(); }
    if(e.key==='+'){ e.preventDefault(); const v=parseInt(mvQty.value||'0',10)||0; mvQty.value=String(Math.max(1,v+1)); }
    if(e.key==='-'){ e.preventDefault(); const v=parseInt(mvQty.value||'0',10)||0; mvQty.value=String(Math.max(1,v-1)); }
  });
}

// Ekstern (Zebra hardware / WebSocket) skann støtte
// Denne funksjonen trigges fra mobile.html via window.__handleExternalScan
window.__handleExternalScan = async function(code, source){
  try {
    dlog('Ekstern scan ('+(source||'ukjent')+'): '+code);
  const clean = String(code).trim();
  if(!clean){ dlog('Tom kode ignorert'); return; }
  // Hvis bevegelsespanel er åpent og skann er kun tall (1-4 sifre), tolk som antall override
  if(!movementPanel.classList.contains('hidden') && /^[0-9]{1,4}$/.test(clean)){
    mvQty.value = String(Math.max(1, parseInt(clean,10)));
    try { mvQty.focus(); mvQty.select(); } catch(_){}
    dlog('Tolk skann som antall: '+clean);
    return;
  }
  // Først: sjekk om dette er en lokasjonskode
  const isLoc = await isLocationBarcode(clean);
  if(isLoc){ setCurrentLocation(clean); return; }
  await handleScan(clean, source||'ext');
  } catch(e){ dlog('Ekstern scan feil: '+(e.message||e)); }
};

// ===== Edit Modal Logic =====
const edModal = document.getElementById('edit-modal');
const edClose = document.getElementById('edit-close');
const edPart = document.getElementById('ed-part');
const edDesc = document.getElementById('ed-desc');
const edMin = document.getElementById('ed-min');
const edMinInc = document.getElementById('ed-min-inc');
const edMinDec = document.getElementById('ed-min-dec');
const edFixedLoc = document.getElementById('ed-fixed-loc');
const edScanFixed = document.getElementById('ed-scan-fixed');
const edClearFixed = document.getElementById('ed-clear-fixed');
const edStockLoc = document.getElementById('ed-stock-loc');
const edScanStockLoc = document.getElementById('ed-scan-stock-loc');
const edQty = document.getElementById('ed-qty');
const edQtyInc = document.getElementById('ed-qty-inc');
const edQtyDec = document.getElementById('ed-qty-dec');
const edSave = document.getElementById('ed-save');
const edCancel = document.getElementById('ed-cancel');
const edMsg = document.getElementById('ed-msg');

let edFixedLocBarcode = null;
let edStockLocBarcode = null;

function openEdit(){ if(edModal){ edModal.classList.remove('hidden'); } }
function closeEdit(){ if(edModal){ edModal.classList.add('hidden'); edMsg.textContent=''; } }
function numOnlyInput(el){ if(!el) return; el.addEventListener('input', ()=> { const d=(el.value||'').replace(/\D+/g,''); if(el.value!==d) el.value=d; }); }
numOnlyInput(edMin); numOnlyInput(edQty);
if(edMinInc) edMinInc.addEventListener('click', ()=> { const v=parseInt(edMin.value||'0',10)||0; edMin.value=String(Math.max(0,v+1)); });
if(edMinDec) edMinDec.addEventListener('click', ()=> { const v=parseInt(edMin.value||'0',10)||0; edMin.value=String(Math.max(0,v-1)); });
if(edQtyInc) edQtyInc.addEventListener('click', ()=> { const v=parseInt(edQty.value||'0',10)||0; edQty.value=String(Math.max(0,v+1)); });
if(edQtyDec) edQtyDec.addEventListener('click', ()=> { const v=parseInt(edQty.value||'0',10)||0; edQty.value=String(Math.max(0,v-1)); });

function showFixedLoc(text){ edFixedLoc.textContent = text || '–'; }
function showStockLoc(text){ edStockLoc.textContent = text || '–'; }

function primeEditWithCurrent(){
  if(!currentPartData || !currentPartData.part) return;
  const part = currentPartData.part;
  edPart.value = part.part_number || '';
  edDesc.value = part.description || '';
  edMin.value = String(part.min_qty || 0);
  // fixed loc
  edFixedLocBarcode = null;
  if(part.default_location_id && Array.isArray(currentPartData.locations)){
    const loc = currentPartData.locations.find(l=> String(l.location_id) === String(part.default_location_id));
    if(loc){ edFixedLocBarcode = loc.barcode; showFixedLoc(loc.location_name + ' ('+loc.barcode+')'); }
    else { showFixedLoc('–'); }
  } else { showFixedLoc('–'); }
  // stock loc default: use fixed loc if exists
  edStockLocBarcode = edFixedLocBarcode || currentLocationBarcode || null;
  if(edStockLocBarcode){
    const loc = (currentPartData.locations||[]).find(l=> l.barcode === edStockLocBarcode);
    showStockLoc(loc ? (loc.location_name+' ('+loc.barcode+')') : edStockLocBarcode);
    // preset qty with existing at that loc if known
    if(loc){ edQty.value = String(Math.max(0, parseInt(loc.qty||'0',10)||0)); } else { edQty.value = '0'; }
  } else {
    showStockLoc('–'); edQty.value='0';
  }
}

if(openEditBtn){ openEditBtn.addEventListener('click', ()=> { primeEditWithCurrent(); openEdit(); }); }
if(edClose){ edClose.addEventListener('click', closeEdit); }
if(edCancel){ edCancel.addEventListener('click', closeEdit); }
if(edClearFixed){ edClearFixed.addEventListener('click', ()=> { edFixedLocBarcode=null; showFixedLoc('–'); }); }
if(edScanFixed){ edScanFixed.addEventListener('click', ()=> { dlog('Skann lokasjon for fast plass (bruk skanner)'); }); }
if(edScanStockLoc){ edScanStockLoc.addEventListener('click', ()=> { dlog('Skann lokasjon for lagerantall (bruk skanner)'); }); }

async function resolveIfLocation(code){
  const isLoc = await isLocationBarcode(code);
  return !!isLoc;
}

// Integrate scanner with edit modal
const prevExternalScan = window.__handleExternalScan;
window.__handleExternalScan = async function(code, source){
  try{
    const clean = String(code||'').trim();
    if(!clean) return;
    // if modal open and scanning a location, route to either fixed or stock loc depending on prompt focus
    const modalOpen = edModal && !edModal.classList.contains('hidden');
    if(modalOpen){
      const isLoc = await resolveIfLocation(clean);
      if(isLoc){
        // prioritize a recent "scan fixed" click by setting a short flag
        const target = window._scanTarget || 'stock';
        if(target === 'fixed'){ edFixedLocBarcode = clean; showFixedLoc(clean); }
        else { edStockLocBarcode = clean; showStockLoc(clean); }
        window._scanTarget = null;
        dlog('Modal satte lokasjon '+target+': '+clean);
        return;
      }
    }
    // fallback to existing behavior
    if(prevExternalScan){ return prevExternalScan(code, source); }
  } catch(e){ dlog('Edit modal scan feil: '+(e.message||e)); }
};
if(edScanFixed){ edScanFixed.addEventListener('click', ()=> { window._scanTarget = 'fixed'; }); }
if(edScanStockLoc){ edScanStockLoc.addEventListener('click', ()=> { window._scanTarget = 'stock'; }); }

if(edSave){
  edSave.addEventListener('click', async ()=>{
    try{
      edSave.disabled=true; edMsg.textContent='';
      const pn = (edPart.value||'').trim();
      if(!pn) { edMsg.textContent='Mangler delenummer'; return; }
      const desc = (edDesc.value||'').trim();
      const minq = parseInt(edMin.value||'0',10)||0;
      // update part (clear fixed if no barcode set)
      // first resolve part id from currentPartData
      const partId = currentPartData && currentPartData.part ? currentPartData.part.id : null;
      if(!partId){ edMsg.textContent='Internt problem: mangler part id'; return; }
      const body = { part_number: pn, description: desc, min_qty: minq };
      if(edFixedLocBarcode){ body.default_location_barcode = edFixedLocBarcode; }
      await api('/api/parts/'+partId, 'PUT', body);
      // set stock if a stock location is chosen
      if(edStockLocBarcode != null){
        const qty = Math.max(0, parseInt(edQty.value||'0',10)||0);
        await api('/api/stock/set','POST',{ part_number: pn, location_barcode: edStockLocBarcode, qty });
      }
      edMsg.textContent='Lagret';
      // refresh info for the part panel
      currentPartData = await api('/api/stock/'+encodeURIComponent(pn));
      // update UI info block
      await handleScan(pn, 'edit');
      closeEdit();
    } catch(e){ edMsg.textContent = 'Feil: '+(e.error||e.message||e); }
    finally { edSave.disabled=false; }
  });
}

