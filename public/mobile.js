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
const startBtn = document.getElementById('start-scan');
const stopBtn = document.getElementById('stop-scan');
const videoEl = document.getElementById('video');
const scanStatus = document.getElementById('scan-status');
const lastScan = document.getElementById('last-scan');

let scanning = false;
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

startBtn.addEventListener('click', () => {
  if (scanning) return;
  scanStatus.innerText = 'Starter kamera...';
  startCameraScanner();
});
stopBtn.addEventListener('click', () => {
  stopCameraScanner();
});

function startCameraScanner() {
  if (scanning) return;
  // Check for browser support
  if (!(navigator && navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function')) {
    scanStatus.innerText = 'Kamera ikke tilgjengelig i denne nettleseren eller krever HTTPS. Bruk Chrome/Edge og åpne via HTTPS eller localhost, eller bruk manuell registrering.';
    return;
  }

  scanning = true;
  Quagga.init({
    inputStream: {
      name: "Live",
      type: "LiveStream",
      target: videoEl,
      constraints: { facingMode: "environment" }
    },
    decoder: { readers: ["code_128_reader","ean_reader","ean_8_reader"] }
  }, function(err) {
    if (err) { scanStatus.innerText = 'Feil ved oppstart: ' + (err.message || err); scanning = false; return; }
    Quagga.start();
    scanStatus.innerText = 'Skanner...';
  });

  Quagga.onDetected(d => {
    const code = d && d.codeResult && d.codeResult.code;
    if (code) onBarcodeScanned(code);
  });
}

function stopCameraScanner() {
  if (!scanning) return;
  scanning = false;
  Quagga.stop();
  scanStatus.innerText = 'Stoppet';
}

async function onBarcodeScanned(code) {
  stopCameraScanner();
  lastScan.innerText = code;
  const loc = locSelect.value;
  // If scanned code looks like a location barcode, allow setting location
  const pickLoc = confirm(`Skannet: ${code}. Er dette en lokasjon? (OK = Ja)`);
  if (pickLoc) {
    // find in options
    const opt = Array.from(locSelect.options).find(o => o.value === code || o.text.includes(code));
    if (opt) { locSelect.value = opt.value; alert('Valgt lokasjon: ' + opt.text); }
    else { if (confirm('Lokasjon ikke funnet - vil du legge den til?')) {
      const name = prompt('Navn for lokasjon', code) || code;
      await api('/api/locations', 'POST', { name, barcode: code });
      await loadLocations();
      locSelect.value = code;
    }}
    return;
  }

  // ellers spør om inn/ut og antall
  const action = confirm('Vil du registrere UT? OK = UT, Avbryt = INN') ? 'out' : 'in';
  const qty = parseInt(prompt('Antall', '1') || '1', 10);
  if (!locSelect.value) return alert('Velg lokasjon først');
  try {
    await api('/api/stock/scan', 'POST', { location_barcode: locSelect.value, part_number: code, qty, action });
    alert('Registrert ' + action + ' ' + qty + ' av ' + code);
  } catch (e) {
    alert('Feil: ' + JSON.stringify(e));
  }
}

// handle manual add
document.getElementById('manual-add').addEventListener('click', async () => {
  const pn = prompt('Delenummer') || '';
  const action = confirm('UT? OK=UT, Avbryt=INN') ? 'out' : 'in';
  const qty = parseInt(prompt('Antall','1')||'1',10);
  if (!pn) return;
  if (!locSelect.value) return alert('Velg lokasjon først');
  try {
    await api('/api/stock/scan','POST',{ location_barcode: locSelect.value, part_number: pn, qty, action });
    alert('Registrert');
  } catch(e){ alert('Feil: '+JSON.stringify(e)); }
 });

function setNgrokStatus(msg, error=false){ if(ngrokStatus){ ngrokStatus.textContent=msg; ngrokStatus.style.color=error?'crimson':'#555'; } }
function renderQR(url){
  if(!ngrokQr) return;
  ngrokQr.innerHTML = '';
  const canvas = document.createElement('canvas');
  ngrokQr.appendChild(canvas);
  // Simple fallback using external API (no lib):
  const img = document.createElement('img');
  img.alt='QR';
  img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data='+encodeURIComponent(url);
  ngrokQr.appendChild(img);
  const link = document.createElement('a'); link.href=url; link.textContent='Åpne'; link.target='_blank'; link.style.display='block'; link.style.marginTop='6px';
  ngrokQr.appendChild(link);
}

if(ngrokStartBtn){
  ngrokStartBtn.addEventListener('click', async () => {
    setNgrokStatus('Starter ngrok...');
    try {
      const r = await fetch('/api/ngrok/start', { method:'POST' });
      const j = await r.json();
      if(!r.ok || !j.ok){ setNgrokStatus('Feil: '+(j.error||r.statusText), true); return; }
      setNgrokStatus('Aktiv: '+j.url);
      renderQR(j.url);
    } catch(e){ setNgrokStatus('Feil ved start: '+e.message,true);}  
  });
}
if(ngrokStopBtn){
  ngrokStopBtn.addEventListener('click', async () => {
    setNgrokStatus('Stopper ngrok...');
    try { const r= await fetch('/api/ngrok/stop',{method:'POST'}); const j=await r.json(); if(j.ok) { setNgrokStatus('Stoppet'); ngrokQr.innerHTML=''; } else setNgrokStatus('Kunne ikke stoppe',true);} catch(e){ setNgrokStatus('Feil: '+e.message,true);}  
  });
}
if(ngrokGenerateBtn){
  ngrokGenerateBtn.addEventListener('click', () => {
    const url = (ngrokUrlInput && ngrokUrlInput.value || '').trim();
    if(!url) { setNgrokStatus('Lim inn URL først', true); return; }
    renderQR(url);
    setNgrokStatus('QR generert');
  });
}
