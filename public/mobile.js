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
  }
});

function dlog(msg){
  if(!debugLog) return; const ts = new Date().toISOString().substr(11,8);
  debugLog.textContent += `[${ts}] ${msg}\n`;
}
if(debugBtn){
  debugBtn.addEventListener('click', ()=> {
    if(debugLog.style.display==='none'){ debugLog.style.display='block'; debugBtn.textContent='Skjul debug'; }
    else { debugLog.style.display='none'; debugBtn.textContent='Debug'; }
  });
}


// Kamera-funksjoner fjernet

let scanMode = 'part'; // stabil modus – vi skanner kun deler via HW/WS

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
    const part = data.part || {}; const total = data.total || 0;
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

// handle manual add
// Manuell del-knapp fjernet

mvCancel.addEventListener('click', ()=> { movementPanel.classList.add('hidden'); });
mvSubmit.addEventListener('click', async () => {
  const part = mvPart.value.trim();
  const qty = parseInt(mvQty.value||'0',10);
  const action = movementMode || mvAction.value; // tvang om satt
  if(!part || !qty){ mvMessage.textContent='Mangler felt'; return; }
  mvSubmit.disabled=true;
  try {
  await api('/api/stock/scan','POST',{ part_number: part, qty, action });
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
  await handleScan(clean, source||'ext');
  } catch(e){ dlog('Ekstern scan feil: '+(e.message||e)); }
};

