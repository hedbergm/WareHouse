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

const mobilePass = document.getElementById('mobile-pass');
const loginBtn = document.getElementById('mobile-login');
const loginScreen = document.getElementById('login-screen');
const mainScreen = document.getElementById('main-screen');
const locSelect = document.getElementById('loc-select');
const scanLocBtn = document.getElementById('scan-loc');
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
const debugBtn = document.getElementById('toggle-debug');
const debugLog = document.getElementById('debug-log');

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
let scanMode = null; // 'loc' | 'part'
let currentLoc = null;

loginBtn.addEventListener('click', async () => {
  const u = prompt('Brukernavn') || '';
  const p = mobilePass.value || '';
  if (!u || !p) return alert('Brukernavn og passord kreves');
  try {
    const r = await api('/api/mobile/login','POST',{ username: u.trim(), password: p });
    sessionStorage.setItem('mobile-token', r.token);
    sessionStorage.setItem('mobile-user', r.username);
    loginScreen.classList.add('hidden');
    mainScreen.classList.remove('hidden');
    loadLocations();
  } catch (e) { alert('Login feilet'); }
});

async function loadLocations() {
  const locs = await api('/api/locations').catch(()=>[]);
  locSelect.innerHTML = '<option value="">Velg lokasjon</option>' + locs.map(l => `<option value="${l.barcode}">${l.name} (${l.barcode})</option>`).join('');
}

scanLocBtn.addEventListener('click', () => startScan('loc'));
scanPartBtn.addEventListener('click', () => startScan('part'));
stopBtn.addEventListener('click', () => stopCameraScanner());

function startScan(mode){
  if(scanning) return;
  scanMode = mode;
  scanStatus.innerText = mode === 'loc' ? 'Skanner lokasjon...' : 'Skanner del...';
  startCameraScanner();
}

function startCameraScanner(){
  if (scanning) return;
  if (!(navigator && navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function')) {
    scanStatus.innerText = 'Kamera ikke tilgjengelig / krever HTTPS.';
    dlog('getUserMedia ikke tilgjengelig');
    return;
  }
  // Permission preflight
  if(navigator.permissions && navigator.permissions.query){
    navigator.permissions.query({ name: 'camera' }).then(r=> dlog('Permission camera: '+r.state)).catch(()=>{});
  }
  navigator.mediaDevices.enumerateDevices().then(list=>{
    const cams = list.filter(d=> d.kind==='videoinput');
    dlog('Fant '+cams.length+' kamera(er)');
  }).catch(e=> dlog('enumerateDevices feil: '+e.message));
  scanning = true;
  stopBtn.disabled = false;
  videoEl.textContent = '';
  try { Quagga.offDetected(); } catch(_) {}
  Quagga.init({
    inputStream: { name:'Live', type:'LiveStream', target: videoEl, constraints:{ facingMode:'environment' } },
    locate: true,
    numOfWorkers: navigator.hardwareConcurrency ? Math.min(4, navigator.hardwareConcurrency) : 2,
    decoder: { readers:[ 'code_128_reader' ] }
  }, err => {
    if(err){
      const msg = 'Feil ved oppstart: '+(err.message||err);
      scanStatus.innerText = msg;
      dlog(msg);
      scanning=false; stopBtn.disabled=true; return;
    }
    Quagga.start();
    scanStatus.innerText = scanMode === 'loc' ? 'Skann en lokasjon strekkode' : 'Skann en del strekkode';
    dlog('Quagga startet');
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
  scanning=false; Quagga.stop(); scanStatus.innerText='Stoppet'; stopBtn.disabled=true; scanMode=null; if(!videoEl.hasChildNodes()) videoEl.textContent='Ingen aktiv skann';
}

async function handleScan(code){
  stopCameraScanner();
  lastScan.innerText = (scanMode==='loc'?'Lokasjon: ':'Del: ')+code;
  if(scanMode==='loc'){
    const opt = Array.from(locSelect.options).find(o=> o.value===code || o.text.includes(code));
    if(opt){ locSelect.value=opt.value; scanStatus.innerText='Lokasjon valgt'; return; }
    // create new location quickly
    try { await api('/api/locations','POST',{ name: code, barcode: code }); await loadLocations(); locSelect.value=code; scanStatus.innerText='Lokasjon opprettet'; }
    catch(e){ scanStatus.innerText='Feil lokasjon'; }
    return;
  }
  // part scan
  if(!locSelect.value){ scanStatus.innerText='Velg / skann lokasjon først'; return; }
  mvPart.value = code;
  mvQty.value = 1;
  mvAction.value = 'in';
  movementPanel.classList.remove('hidden');
  mvMessage.textContent = '';
}

// handle manual add
document.getElementById('manual-add').addEventListener('click', () => {
  if(!locSelect.value){ alert('Velg lokasjon først'); return; }
  const pn = prompt('Delenummer'); if(!pn) return;
  mvPart.value = pn.trim();
  mvQty.value = 1; mvAction.value='in'; movementPanel.classList.remove('hidden'); mvMessage.textContent='';
});

mvCancel.addEventListener('click', ()=> { movementPanel.classList.add('hidden'); });
mvSubmit.addEventListener('click', async () => {
  const part = mvPart.value.trim();
  const qty = parseInt(mvQty.value||'0',10);
  const action = mvAction.value;
  if(!part || !qty || !locSelect.value){ mvMessage.textContent='Mangler felt'; return; }
  mvSubmit.disabled=true;
  try {
    await api('/api/stock/scan','POST',{ location_barcode: locSelect.value, part_number: part, qty, action });
    mvMessage.textContent='Lagret'; movementPanel.classList.add('hidden');
  } catch(e){ mvMessage.textContent='Feil: '+ (e.error||''); }
  finally { mvSubmit.disabled=false; }
});

