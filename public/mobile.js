async function api(path, method='GET', body) {
  const opts = { method, headers: {} };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(path, opts);
  return res.ok ? res.json() : Promise.reject(await res.json());
}

// Ensure getUserMedia exists (polyfill for older prefixes) and give clear info if not
if (typeof navigator !== 'undefined') {
  try {
    if (!navigator.mediaDevices) navigator.mediaDevices = {};
    if (!navigator.mediaDevices.getUserMedia) {
      navigator.mediaDevices.getUserMedia = function(constraints) {
        var getUserMedia = navigator.webkitGetUserMedia || navigator.mozGetUserMedia || navigator.getUserMedia;
        if (!getUserMedia) return Promise.reject(new Error('getUserMedia not implemented'));
        return new Promise(function(resolve, reject) {
          getUserMedia.call(navigator, constraints, resolve, reject);
        });
      }
    }
  } catch (e) {
    // ignore
  }
}

// Login removed
const mainScreen = document.getElementById('main-screen');
// Lokasjonshåndtering fjernet (fast lokasjon per del)
const scanPartBtn = document.getElementById('scan-part');
const stopBtn = document.getElementById('stop-scan');
const videoEl = document.getElementById('video');
const scanStatus = document.getElementById('scan-status');
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


let scanning = false;
let scanMode = null; // only 'part'
let currentLoc = null;

// Location selection removed; start part scanning directly
scanPartBtn.addEventListener('click', () => startScan('part'));
stopBtn.addEventListener('click', () => stopCameraScanner());

function startScan(mode){
  if(scanning) return;
  scanMode = mode;
  scanStatus.innerText = 'Skanner del...';
  videoEl.classList.remove('scanning-part');
  videoEl.classList.add('scanning-part');
  startCameraScanner();
}

function startCameraScanner(){
  if (scanning) return;
  if (!(navigator && navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function')) {
    scanStatus.innerText = 'Kamera ikke tilgjengelig / krever HTTPS.';
    dlog('getUserMedia ikke tilgjengelig');
  scanStatus.innerHTML += '<br>Bruk Foto-scan knappen som fallback.';
    return;
  }
  // Permission preflight
  if(navigator.permissions && navigator.permissions.query){
    navigator.permissions.query({ name: 'camera' }).then(r=> {
      dlog('Permission camera: '+r.state);
      if(r.state === 'denied'){
        scanStatus.innerHTML = 'Kamera blokkert av nettleser. Tillat kamera:<br>• Chrome: Trykk lås‑ikon → Nettstedsinnstillinger → Kamera → Tillat<br>• Safari iOS: Innstillinger → Safari → Kamera → Tillat / Spør eller AA‑ikon → Nettstedsinnstillinger.<br>Endre, gå tilbake og trykk skann igjen.';
        return;
      }
    }).catch(()=>{});
  }
  navigator.mediaDevices.enumerateDevices().then(list=>{
    const cams = list.filter(d=> d.kind==='videoinput');
    dlog('Fant '+cams.length+' kamera(er)');
  }).catch(e=> dlog('enumerateDevices feil: '+e.message));
  scanning = true;
  stopBtn.disabled = false;
  videoEl.textContent = '';
  // ensure guide overlay remains
  if(!videoEl.querySelector('.scan-guide')){ const g=document.createElement('div'); g.className='scan-guide'; videoEl.appendChild(g); }
  try { Quagga.offDetected(); } catch(_) {}
  const quaggaConfig = {
    inputStream: { name:'Live', type:'LiveStream', target: videoEl, constraints:{ facingMode:'environment' } },
    locate: true,
    numOfWorkers: navigator.hardwareConcurrency ? Math.min(4, navigator.hardwareConcurrency) : 2,
    decoder: { readers:[ 'code_128_reader' ] }
  };
  // Preflight permission by calling getUserMedia first (Android noen ganger trenger direkte kall)
  navigator.mediaDevices.getUserMedia({ video: { facingMode:'environment' } }).then(stream => {
    stream.getVideoTracks().forEach(t=> t.stop());
    dlog('Preflight kamera OK');
    Quagga.init(quaggaConfig, err => {
    if(err){
      const msg = 'Feil ved oppstart: '+(err.message||err);
      scanStatus.innerText = msg;
      dlog(msg);
      scanning=false; stopBtn.disabled=true; return;
    }
    Quagga.start();
  scanStatus.innerText = 'Skann en del strekkode';
    dlog('Quagga startet');
  });
  }).catch(e => {
    dlog('Preflight feilet: '+e.message);
    scanStatus.innerText='Kamera tilgang blokkert: '+e.message;
  });
  let pendingCode = null; let pendingTime = 0;
  Quagga.onDetected(det => {
    const code = det && det.codeResult && det.codeResult.code;
    if(!code) return;
    // Enkle sanity checks: Code128 med bindestrek skal ikke bli kun tall
    // Dobbel-bekreftelse for å redusere feil-lesning
    const now = Date.now();
    if (pendingCode === code && (now - pendingTime) < 1200) {
      handleScan(code);
    } else {
      pendingCode = code; pendingTime = now; scanStatus.innerText = 'Bekreft skann: '+code+' (hold rolig)';
    }
  });
}

function stopCameraScanner(){
  if(!scanning) return;
  scanning=false; Quagga.stop(); scanStatus.innerText='Stoppet'; stopBtn.disabled=true; if(!videoEl.hasChildNodes()) videoEl.textContent='Ingen aktiv skann';
  videoEl.classList.remove('scanning-part');
}

async function handleScan(code){
  const mode = scanMode; // capture before stopping (stop clears state UI-wise)
  stopCameraScanner();
  lastScan.innerText = 'Del: '+code;
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
  // Hent delinfo (lager + min + beskrivelse)
  try {
    const data = await api('/api/stock/'+encodeURIComponent(code));
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

// Ekstern (Zebra hardware / WebSocket) skann støtte
// Denne funksjonen trigges fra mobile.html via window.__handleExternalScan
window.__handleExternalScan = async function(code, source){
  try {
    dlog('Ekstern scan ('+(source||'ukjent')+'): '+code);
    // Hvis kamera skanner pågår, stopp for å unngå UI konflikt
    if(scanning) stopCameraScanner();
    await handleScan(String(code).trim());
  } catch(e){ dlog('Ekstern scan feil: '+(e.message||e)); }
};

