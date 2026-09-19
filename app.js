(function(){
  "use strict";

  // ---------- Storage shim ----------
  // This app can run two ways: (1) inside Claude's artifact viewer, which
  // provides window.storage automatically, or (2) as a plain HTML file
  // opened directly in a browser (double-tapped from Downloads, etc.),
  // where window.storage doesn't exist. When it's missing, fall back to
  // the browser's own localStorage so the app still saves data on this device.
  if(typeof window.storage === 'undefined'){
  const SUPABASE_URL = 'https://dfusszxejwlszhzutczg.supabase.co';
  const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_QYfqF9XKQbCu4wpZVvyR-Q_-w1-pD3_';

  const supabaseReady = new Promise((resolve, reject) => {
    if(window.supabase && window.supabase.createClient){
      resolve(window.supabase.createClient(
        SUPABASE_URL,
        SUPABASE_PUBLISHABLE_KEY,
        { auth: { persistSession: false } }
      ));
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
    script.onload = () => {
      if(!window.supabase || !window.supabase.createClient){
        reject(new Error('Supabase library failed to load'));
        return;
      }

      resolve(window.supabase.createClient(
        SUPABASE_URL,
        SUPABASE_PUBLISHABLE_KEY,
        { auth: { persistSession: false } }
      ));
    };
    script.onerror = () => reject(new Error('Could not load Supabase'));
    document.head.appendChild(script);
  });

  window.storage = {
    async get(key){
      const supabase = await supabaseReady;

      const { data, error } = await supabase
        .from('app_storage')
        .select('value')
        .eq('key', key)
        .maybeSingle();

      if(error) throw error;
      if(!data) throw new Error('Key not found: ' + key);

      return { key, value: data.value, shared: true };
    },

    async set(key, value){
      const supabase = await supabaseReady;

      const { error } = await supabase
        .from('app_storage')
        .upsert(
          { key, value, updated_at: new Date().toISOString() },
          { onConflict: 'key' }
        );

      if(error) throw error;

      return { key, value, shared: true };
    },

    async delete(key){
      const supabase = await supabaseReady;

      const { error } = await supabase
        .from('app_storage')
        .delete()
        .eq('key', key);

      if(error) throw error;

      return { key, deleted: true, shared: true };
    },

    async list(prefix){
      const supabase = await supabaseReady;

      const { data, error } = await supabase
        .from('app_storage')
        .select('key');

      if(error) throw error;

      const p = prefix || '';
      const keys = (data || [])
        .map(row => row.key)
        .filter(key => key.startsWith(p));

      return { keys, prefix, shared: true };
    }
  };
}
  // ---------- State ----------
  let products = [];   // {id, barcode, name, stock, threshold}
  let platforms = [];  // [string]
  let salesLog = [];   // {id, barcode, name, platform, qty, ts}
  let currentScreen = "scan";
  let html5Qrcode = null;
  let addHtml5Qrcode = null;
  let pendingProduct = null;
  let pendingQty = 1;
  let logFilter = "all";
  let reportRange = "7d";
  let lastBackupTs = null;
  let pendingImport = null;
  let lockMode = "checking"; // "setup" | "migrate-email" | "login" | "unlocked"
  let authConfig = { users: [] };
  let currentUserEmail = null;
  let currentUserIsOwner = false;
  let currentUserPermissions = { scanSale:true, scanInward:true, inventory:true, log:true, report:true, add:true };
  const ALL_PERMISSIONS = { scanSale:true, scanInward:true, inventory:true, log:true, report:true, add:true };
  const NO_PERMISSIONS = { scanSale:false, scanInward:false, inventory:false, log:false, report:false, add:false };
  let pendingMigration = null;
  function isValidEmail(e){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }

  // ---------- Crypto helpers for app lock ----------
  function passwordMeetsRequirements(pw){
    return pw.length >= 8 && /[A-Z]/.test(pw) && /[a-z]/.test(pw) && /[0-9]/.test(pw) && /[^A-Za-z0-9]/.test(pw);
  }
  const PASSWORD_HINT = "8+ characters with uppercase, lowercase, a number, and a special character.";

  // ---------- Show/hide password toggles ----------
  const EYE_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a20.6 20.6 0 0 1 5.06-5.94M9.9 4.24A10.6 10.6 0 0 1 12 4c7 0 11 7 11 7a20.6 20.6 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  function addPasswordToggle(input){
    if(input.dataset.pwToggled) return;
    input.dataset.pwToggled = '1';
    const wrap = document.createElement('div');
    wrap.className = 'pw-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pw-toggle';
    btn.setAttribute('aria-label', 'Show password');
    btn.innerHTML = EYE_OPEN;
    wrap.appendChild(btn);
    btn.addEventListener('click', ()=>{
      if(input.type === 'password'){
        input.type = 'text';
        btn.innerHTML = EYE_OFF;
        btn.setAttribute('aria-label', 'Hide password');
      }else{
        input.type = 'password';
        btn.innerHTML = EYE_OPEN;
        btn.setAttribute('aria-label', 'Show password');
      }
    });
  }
  document.querySelectorAll('input[type="password"]').forEach(addPasswordToggle);
  function genSalt(){
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    return Array.from(arr).map(b=>b.toString(16).padStart(2,'0')).join('');
  }
  async function hashPassword(password, salt){
    const enc = new TextEncoder().encode(salt + ':' + password);
    const buf = await crypto.subtle.digest('SHA-256', enc);
    return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
  }
  function escapeHtml(value){
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
  let scanMode = "sale"; // "sale" | "return" | "inward"
  let slackConfig = { webhookUrl: "", notifySale: false, notifyInward: false, notifyLowStock: false };

  const DEFAULT_PLATFORMS = ["Amazon","Flipkart","Shopify","Myntra","Meesho","Website"];

  // ---------- Storage helpers ----------
  async function loadAll(){
    try{
      const p = await window.storage.get('products', false);
      products = p ? JSON.parse(p.value) : [];
    }catch(e){ products = []; }
    try{
      const pf = await window.storage.get('platforms', false);
      platforms = pf ? JSON.parse(pf.value) : [];
    }catch(e){ platforms = []; }
    if(!platforms.length){
      platforms = DEFAULT_PLATFORMS.slice();
      await window.storage.set('platforms', JSON.stringify(platforms), false);
    }
    try{
      const sl = await window.storage.get('sales-log', false);
      salesLog = sl ? JSON.parse(sl.value) : [];
    }catch(e){ salesLog = []; }
    try{
      const sc = await window.storage.get('slack-config', false);
      if(sc) slackConfig = JSON.parse(sc.value);
    }catch(e){ /* no config yet */ }
    try{
      const lb = await window.storage.get('last-backup-ts', false);
      if(lb) lastBackupTs = JSON.parse(lb.value);
    }catch(e){ lastBackupTs = null; }
  }
  async function saveProducts(){ try{ await window.storage.set('products', JSON.stringify(products), false); showToast("CLOUD SAVE OK"); }catch(e){ console.error(e); showToast("CLOUD ERROR: " + (e.message || e), true); } }
  async function savePlatforms(){ try{ await window.storage.set('platforms', JSON.stringify(platforms), false); }catch(e){ showToast("Couldn't save — try again", true); } }
  async function saveLog(){ try{ await window.storage.set('sales-log', JSON.stringify(salesLog), false); }catch(e){ /* non-fatal */ } }
  async function saveSlackConfig(){ try{ await window.storage.set('slack-config', JSON.stringify(slackConfig), false); }catch(e){ showToast("Couldn't save Slack settings"); } }

  // ---------- Slack ----------
  async function sendSlackMessage(text){
    if(!slackConfig.webhookUrl) return { ok:false, skipped:true };
    try{
      const res = await fetch(slackConfig.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      return { ok: res.ok };
    }catch(e){
      return { ok:false, error:e };
    }
  }

  function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }

  // ---------- Toast ----------
  let toastTimer;
  function showToast(msg){
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(()=> t.classList.remove('show'), 2200);
  }

  // ---------- Navigation ----------
  function goTo(screen){
  currentScreen = screen;
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById('screen-'+screen).classList.add('active');
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active', b.dataset.screen===screen));
  document.getElementById('platformSelectWrap').style.display = (screen==='scan' && scanMode==='sale') ? '' : 'none';
  document.getElementById('inwardReasonWrap').style.display = (screen==='scan' && (scanMode==='return' || scanMode==='inward')) ? '' : 'none';

  if(screen !== 'scan') stopScanning();
  if(screen === 'add') stopAddScanning();

  render();

  if(screen === 'scan'){
    setTimeout(()=>{
      const input = document.getElementById('manualBarcode');
      if(input) input.focus();
    }, 100);
  }
}
  document.querySelectorAll('.tab-btn').forEach(b=>{
    b.addEventListener('click', ()=> goTo(b.dataset.screen));
  });

  // ---------- Platform select ----------
  function renderPlatformSelect(){
    const sel = document.getElementById('platformSelect');
    const prev = sel.value;
    sel.innerHTML = platforms.map(p=>`<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');
    if(platforms.includes(prev)) sel.value = prev;
  }

  function renderReasonSelect(){
    const sel = document.getElementById('reasonSelect');
    const wrap = document.getElementById('inwardReasonWrap');
    const label = wrap ? wrap.querySelector('label') : null;
    const prev = sel.value;
    let options = [];

    if(scanMode === 'inward'){
      options = ['New stock (supplier)'];
      if(label) label.textContent = 'Restocking via';
    }else if(scanMode === 'return'){
      options = platforms.map(p => `Return - ${p}`);
      if(label) label.textContent = 'Return via';
    }else{
      sel.innerHTML = '';
      return;
    }

    sel.innerHTML = options.map(o =>
      `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`
    ).join('');

    if(options.includes(prev)) sel.value = prev;
    else if(options.length) sel.value = options[0];
  }

  document.querySelectorAll('.mode-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      scanMode = btn.dataset.mode;

      document.querySelectorAll('.mode-btn').forEach(b=>{
        b.classList.remove('active','inward-active');
      });

      btn.classList.add(
        scanMode === 'inward' ? 'inward-active' : 'active'
      );

      document.getElementById('platformSelectWrap').style.display =
        scanMode === 'sale' ? '' : 'none';

      document.getElementById('inwardReasonWrap').style.display =
        (scanMode === 'return' || scanMode === 'inward') ? '' : 'none';

      document.getElementById('scanResultArea').innerHTML = '';
      pendingProduct = null;
      scanItems = [];

      render();
    });
  });

  // ---------- Scan screen ----------
  function isValidEAN13(code){ return /^\d{13}$/.test(code); }

  const startBtn = document.getElementById('startScanBtn');
  const stopBtn = document.getElementById('stopScanBtn');
  const scanIdle = document.getElementById('scanIdle');

  async function startScanning(){
    document.getElementById('scanResultArea').innerHTML = '';
    try{
      html5Qrcode = new Html5Qrcode("reader");
      scanIdle.style.display = 'none';
      startBtn.style.display = 'none';
      stopBtn.style.display = '';
      await html5Qrcode.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 260, height: 140 }, formatsToSupport: [Html5QrcodeSupportedFormats.EAN_13] },
        onScanSuccess,
        ()=>{}
      );
    }catch(err){
      scanIdle.style.display = '';
      startBtn.style.display = '';
      stopBtn.style.display = 'none';
      showToast("Camera unavailable — try manual entry below");
    }
  }
  async function stopScanning(){
    if(html5Qrcode){
      try{ await html5Qrcode.stop(); html5Qrcode.clear(); }catch(e){}
      html5Qrcode = null;
    }
    scanIdle.style.display = '';
    startBtn.style.display = '';
    stopBtn.style.display = 'none';
  }
  async function onScanSuccess(decodedText){
  if(scanEventBusy) return;

  scanEventBusy = true;

  if(navigator.vibrate) navigator.vibrate(60);

  try{
    await lookupBarcode(decodedText.trim());
  }catch(e){
    console.error(e);
    showToast("Scan error — please try again", true);
  }

  setTimeout(()=>{
    scanEventBusy = false;
  }, 800);
}
  startBtn.addEventListener('click', startScanning);
  stopBtn.addEventListener('click', stopScanning);

  document.getElementById('manualLookupBtn').addEventListener('click', async ()=>{
  const input = document.getElementById('manualBarcode');
  const v = input.value.trim();

  if(!v) return;

  input.value = '';
  await lookupBarcode(v);

  setTimeout(()=>{
    input.focus();
  }, 50);
});

document.getElementById('manualBarcode').addEventListener('keydown', async e=>{
  if(e.key === 'Enter'){
    e.preventDefault();

    const input = document.getElementById('manualBarcode');
    const v = input.value.trim();

    if(!v) return;

    input.value = '';
    await lookupBarcode(v);

    setTimeout(()=>{
      input.focus();
    }, 50);
  }
});

    let scanItems = [];
  let scanEventBusy = false;

  function renderScanList(message = ''){
    const area = document.getElementById('scanResultArea');

    if(!scanItems.length && !message){
      area.innerHTML = '';
      return;
    }

    const isInward = scanMode === 'inward';
    const isReturn = scanMode === 'return';
    const totalUnits = scanItems.reduce((sum,item)=>sum + item.qty, 0);

    let html = '';

    if(scanItems.length){
      html += `
        <div class="section-title" style="margin-top:14px;">
          Scanned Products · ${totalUnits} units
        </div>
      `;

      html += scanItems.map(item=>{
        const p = products.find(x=>x.id === item.productId);
        if(!p) return '';

        return `
          <div class="result-card" style="padding:13px 14px; margin-top:8px;">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
              <div style="min-width:0;">
                <span class="barcode-tag mono">${escapeHtml(p.barcode)}</span>
                <h3 style="font-size:15px;margin:2px 0 3px;">
                  ${escapeHtml(p.name)}
                </h3>
                <div class="stock-line" style="margin-bottom:0;">
                  ${p.stock} currently in stock
                </div>
              </div>

              <button
                class="btn btn-danger btn-sm remove-scan-btn"
                data-id="${item.id}"
                style="width:auto;flex-shrink:0;">
                Remove
              </button>
            </div>

            <div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;">
              <div style="font-size:12px;color:var(--muted);">
                ${isInward
                  ? escapeHtml(item.reason || 'Inward')
                  : isReturn
                    ? escapeHtml(item.reason || item.platform || 'Return')
                    : escapeHtml(item.platform || 'Sale')}
              </div>

              ${
                isInward
                ? `
                  <div style="display:flex;align-items:center;gap:8px;">
  <input
    type="number"
    min="1"
    inputmode="numeric"
    class="qty-num-input scan-qty-input"
    data-id="${item.id}"
    value="${item.qty}"
    style="width:90px;"
  >
  <button
    class="btn btn-amber btn-sm scan-add-qty"
    data-id="${item.id}"
    style="width:auto;">
    Add
  </button>
</div>
                `
                : `
                  <div style="font-family:'IBM Plex Mono',monospace;font-size:18px;font-weight:700;">
                    ×${item.qty}
                  </div>
                `
              }
            </div>
          </div>
        `;
      }).join('');
    }

    if(message){
      html += `
        <div class="not-found">
          <h3>${escapeHtml(message.title)}</h3>
          <p>${escapeHtml(message.text)}</p>
          ${
            message.code
            ? `<button class="btn btn-amber btn-sm" id="goAddFromScan">
                Add this product
              </button>`
            : ''
          }
        </div>
      `;
    }

    area.innerHTML = html;

    area.querySelectorAll('.remove-scan-btn').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        removeScannedItem(btn.dataset.id);
      });
    });

    area.querySelectorAll('.scan-add-qty').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    const input = area.querySelector(
      `.scan-qty-input[data-id="${btn.dataset.id}"]`
    );

    if(!input) return;

    let qty = parseInt(input.value, 10);

    if(isNaN(qty) || qty < 1){
      qty = 1;
      input.value = 1;
    }

    addInwardQuantity(btn.dataset.id, qty);
  });
});

    if(message && message.code){
      document.getElementById('goAddFromScan').addEventListener('click', ()=>{
        goTo('add');
        document.getElementById('addBarcode').value = message.code;
      });
    }
  }

  async function lookupBarcode(code){
    code = String(code || '').trim();

    if(!isValidEAN13(code)){
      renderScanList({
        title: 'Not a valid barcode',
        text: `Only 13-digit EAN barcodes are supported. "${code}" doesn't match.`
      });
      return;
    }

    const product = products.find(p => p.barcode === code);

    if(!product){
      renderScanList({
        title: `No product matches "${code}"`,
        text: 'Add it now so future scans on any platform recognise it.',
        code
      });
      return;
    }

    await addScannedProduct(product);
  }

  async function addScannedProduct(product){
    const isInward = scanMode === 'inward';

    if(scanMode === 'sale' && product.stock <= 0){
      showToast(`${product.name} is out of stock`);
      return;
    }

    const selectedReason = document.getElementById('reasonSelect').value;

const platform = scanMode === 'sale'
  ? document.getElementById('platformSelect').value
  : scanMode === 'return'
    ? selectedReason.replace('Return - ','')
    : null;

const reason = scanMode === 'return'
  ? selectedReason
  : scanMode === 'inward'
    ? 'New stock (supplier)'
    : null;

    let item = scanItems.find(x =>
      x.productId === product.id &&
      x.mode === scanMode &&
      x.platform === platform &&
      x.reason === reason
    );

    if(item){
  if(scanMode !== 'inward'){
    item.qty += 1;
  }
}else{
  item = {
    id: uid(),
    productId: product.id,
    qty: isInward ? 0 : 1,
    mode: scanMode,
    platform,
    reason,
    logId: null,
    addedQty: 0,
    added: false
  };

  scanItems.push(item);
}

let log = item.logId
  ? salesLog.find(l => l.id === item.logId)
  : null;

if(!log){
  const logId = uid();

  log = {
    id: logId,
    barcode: product.barcode,
    name: product.name,
    type: scanMode === 'return'
      ? 'return'
      : (isInward ? 'inward' : 'sale'),
    reason: reason,
    platform: platform,
    qty: isInward ? 0 : item.qty,
    ts: Date.now()
  };

  salesLog.unshift(log);
  item.logId = logId;
}else if(scanMode !== 'inward'){
  log.qty = item.qty;
}

    const wasAboveThreshold = product.stock > (product.threshold ?? 5);

    if(scanMode === 'return'){
  product.stock += 1;
}else if(scanMode === 'sale'){
  product.stock = Math.max(0, product.stock - 1);
}

    await saveProducts();
    await saveLog();

   if(!isInward){
  if(scanMode === 'return'){
    showToast(`1 × ${product.name} returned`);

    if(slackConfig.notifySale){
      sendSlackMessage(
        `↩️ *1 × ${product.name}* returned via *${platform}*. Now *${product.stock}* in stock.`
      );
    }
  }else{
    showToast(`1 × ${product.name} sold`);

    if(slackConfig.notifySale){
      sendSlackMessage(
        `🛒 *1 × ${product.name}* sold on *${platform}*. ${product.stock} left.`
      );
    }
  }

      const nowLow = product.stock <= (product.threshold ?? 5);

      if(
        slackConfig.notifyLowStock &&
        wasAboveThreshold &&
        nowLow
      ){
        sendSlackMessage(
          `⚠️ *Low stock:* ${product.name} (${product.barcode}) has only *${product.stock}* left.`
        );
      }
    }

    renderScanList();
    renderTodaySummary();
  }

  function changeScanItemQty(itemId, delta){
  const item = scanItems.find(x => x.id === itemId);
  if(!item) return;

  const product = products.find(p => p.id === item.productId);
  if(!product) return;

  if(scanMode !== 'inward') return;

  if(delta < 0 && item.qty <= 1) return;

  item.qty += delta;
  product.stock += delta;

  const log = salesLog.find(l => l.id === item.logId);
  if(log) log.qty = item.qty;

  saveProducts();
  saveLog();

  renderScanList();
  renderTodaySummary();
}
async function addInwardQuantity(itemId, qty){
  const item = scanItems.find(x => x.id === itemId);
  if(!item) return;

  const product = products.find(p => p.id === item.productId);
  if(!product) return;

  if(item.mode !== 'inward') return;

  qty = parseInt(qty, 10);

  if(isNaN(qty) || qty < 1){
    showToast('Enter a valid quantity', true);
    return;
  }

  const previousQty = item.addedQty || 0;
const newQty = qty;
const delta = newQty - previousQty;

product.stock += delta;

item.qty = newQty;
item.addedQty = newQty;
item.added = true;

  const log = salesLog.find(l => l.id === item.logId);
  if(log){
    log.qty = qty;
  }

  await saveProducts();
  await saveLog();

  showToast(`+${qty} × ${product.name} added to stock`);

  renderScanList();
  renderTodaySummary();
}
  async function removeScannedItem(itemId){
    const itemIndex = scanItems.findIndex(x=>x.id === itemId);
    if(itemIndex === -1) return;

    const item = scanItems[itemIndex];
    const product = products.find(p=>p.id === item.productId);

    if(product){
    if(item.mode === 'sale'){
  product.stock += item.qty;
}else if(item.mode === 'return'){
  product.stock = Math.max(0, product.stock - item.qty);
}else if(item.mode === 'inward'){
  if(item.added){
    product.stock = Math.max(0, product.stock - item.qty);
  }
      }
    
    salesLog = salesLog.filter(l=>l.id !== item.logId);
    scanItems.splice(itemIndex, 1);

    await saveProducts();
    await saveLog();

    renderScanList();
    renderTodaySummary();

    showToast(`${product ? product.name : 'Product'} removed`);
  }
}
  // ---------- Today summary ----------
  function renderTodaySummary(){
    const startOfDay = new Date(); startOfDay.setHours(0,0,0,0);
    const todays = salesLog.filter(l => l.ts >= startOfDay.getTime());
    const sold = todays.filter(l=>l.type==='sale');
    const inward = todays.filter(l=>l.type==='inward');
    const soldQty = sold.reduce((s,l)=>s+l.qty,0);
    const inwardQty = inward.reduce((s,l)=>s+l.qty,0);
    document.getElementById('todaySummary').innerHTML = `
      <div class="stat-card"><div class="num mono">${soldQty}</div><div class="lbl">Sold today</div></div>
      <div class="stat-card"><div class="num mono">${inwardQty}</div><div class="lbl">Restocked today</div></div>
    `;
  }

  // ---------- Inventory screen ----------
  function renderInventory(){
    const q = (document.getElementById('invSearch').value || '').toLowerCase();
    const list = document.getElementById('inventoryList');
    const lowStockItems = products.filter(p => p.stock <= (p.threshold ?? 5));
    const banner = document.getElementById('lowStockBanner');
    banner.innerHTML = lowStockItems.length
      ? `<div class="not-found" style="margin-bottom:16px;"><h3>${lowStockItems.length} product${lowStockItems.length>1?'s':''} running low</h3><p>${lowStockItems.slice(0,3).map(p=>escapeHtml(p.name)).join(', ')}${lowStockItems.length>3?', …':''}</p></div>`
      : '';
    const filtered = products.filter(p => !q || p.name.toLowerCase().includes(q) || p.barcode.toLowerCase().includes(q));
    document.getElementById('skuCount').textContent = products.length + ' SKU' + (products.length===1?'':'s');
    if(!filtered.length){
      list.innerHTML = `<div class="empty-state">${products.length ? 'No matches for that search.' : 'No products yet — add your first one from the Add tab.'}</div>`;
      return;
    }
    list.innerHTML = filtered.map(p=>{
      const low = p.stock <= (p.threshold ?? 5);
      return `<div class="product-row ${low?'low':''}">
        <div>
          <div class="pname">${escapeHtml(p.name)}</div>
          <div class="pmeta mono">${escapeHtml(p.barcode)}</div>
        </div>
        <div class="stock-badge ${low?'low':''}">${p.stock}</div>
      </div>`;
    }).join('');
  }
  document.getElementById('invSearch').addEventListener('input', renderInventory);

  // ---------- Log screen ----------
  function renderLogFilters(){
    const wrap = document.getElementById('logFilterChips');
    const chips = ["all", "restock", ...platforms];
    wrap.innerHTML = chips.map(c=>{
      const label = c==='all' ? 'All' : (c==='restock' ? 'Supplier restock' : escapeHtml(c));
      return `<div class="filter-chip ${logFilter===c?'active':''}" data-p="${escapeHtml(c)}">${label}</div>`;
    }).join('');
    wrap.querySelectorAll('.filter-chip').forEach(chip=>{
      chip.addEventListener('click', ()=>{ logFilter = chip.dataset.p; render(); });
    });
  }
  function renderLog(){
    const list = document.getElementById('logList');
    const entries = salesLog.filter(l=>{
      if(logFilter==='all') return true;
      if(logFilter==='restock') return l.type==='inward' && !l.platform;
      return l.platform === logFilter;
    }).slice(0, 200);
    if(!entries.length){
      list.innerHTML = `<div class="empty-state">No entries yet for this filter.</div>`;
      return;
    }
    list.innerHTML = entries.map(l=>{
      const d = new Date(l.ts);
      const time = d.toLocaleDateString(undefined,{month:'short', day:'numeric'}) + ' · ' + d.toLocaleTimeString(undefined,{hour:'2-digit', minute:'2-digit'});
      const isInward = l.type === 'inward';
      const tag = isInward ? (l.reason || 'Restock') : l.platform;
      return `<div class="log-row">
        <div>
          <div class="lname">${escapeHtml(l.name)}</div>
          <div class="ltime">${time}</div>
          <span class="log-tag">${escapeHtml(tag)}</span>
        </div>
       <div class="log-qty ${isInward || l.type === 'return' ? 'in' : ''}">${isInward || l.type === 'return' ? '+' : '−'}${l.qty}</div>
      </div>`;
    }).join('');
  }

  // ---------- Report screen ----------
  const REPORT_RANGES = [
    { key: "today", label: "Today" },
    { key: "7d", label: "7 days" },
    { key: "30d", label: "30 days" },
    { key: "all", label: "All time" }
  ];
  function rangeStart(key){
    if(key === 'today'){ const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); }
    if(key === '7d') return Date.now() - 7*24*3600*1000;
    if(key === '30d') return Date.now() - 30*24*3600*1000;
    return 0;
  }
  function reportEntries(){
    const start = rangeStart(reportRange);
    return salesLog.filter(l => l.ts >= start);
  }
  function renderReportChips(){
    const wrap = document.getElementById('reportRangeChips');
    wrap.innerHTML = REPORT_RANGES.map(r=>`<div class="filter-chip ${reportRange===r.key?'active':''}" data-r="${r.key}">${r.label}</div>`).join('');
    wrap.querySelectorAll('.filter-chip').forEach(chip=>{
      chip.addEventListener('click', ()=>{ reportRange = chip.dataset.r; render(); });
    });
  }
  function renderReportStats(){
    const entries = reportEntries();
    const sold = entries.filter(e=>e.type==='sale');
const inward = entries.filter(e=>e.type==='inward');
const returns = entries.filter(e=>e.type==='return');

const soldQty = sold.reduce((s,e)=>s+e.qty,0);
const newStockQty = inward.reduce((s,e)=>s+e.qty,0);
const returnsQty = returns.reduce((s,e)=>s+e.qty,0);
    const availableQty = products.reduce((s,p)=>s+p.stock,0);
    document.getElementById('reportStats').innerHTML = `
      <div class="stat-card"><div class="num mono">${soldQty}</div><div class="lbl">Units sold</div></div>
      <div class="stat-card"><div class="num mono">${newStockQty}</div><div class="lbl">New stock inward</div></div>
      <div class="stat-card"><div class="num mono">${returnsQty}</div><div class="lbl">Returns inward</div></div>
      <div class="stat-card"><div class="num mono">${availableQty}</div><div class="lbl">Units available now</div></div>
    `;
  }
  function renderReportByPlatform(){
    const entries = reportEntries().filter(e=>e.type==='sale');
    const byPlatform = {};
    entries.forEach(e=> byPlatform[e.platform] = (byPlatform[e.platform]||0) + e.qty);
    const rows = Object.entries(byPlatform).sort((a,b)=>b[1]-a[1]);
    const wrap = document.getElementById('reportByPlatform');
    if(!rows.length){
      wrap.innerHTML = `<div class="empty-state">No sales in this range.</div>`;
      return;
    }
    wrap.innerHTML = rows.map(([platform,qty])=>`
      <div class="product-row">
        <div class="pname">${escapeHtml(platform)}</div>
        <div class="stock-badge">${qty}</div>
      </div>`).join('');
  }
  function renderReportTopProducts(){
    const entries = reportEntries().filter(e=>e.type==='sale');
    const byProduct = {};
    entries.forEach(e=>{
      const key = e.barcode;
      if(!byProduct[key]) byProduct[key] = { name: e.name, qty: 0 };
      byProduct[key].qty += e.qty;
    });
    const rows = Object.values(byProduct).sort((a,b)=>b.qty-a.qty).slice(0,5);
    const wrap = document.getElementById('reportTopProducts');
    if(!rows.length){
      wrap.innerHTML = `<div class="empty-state">No sales in this range.</div>`;
      return;
    }
    wrap.innerHTML = rows.map(r=>`
      <div class="product-row">
        <div class="pname">${escapeHtml(r.name)}</div>
        <div class="stock-badge">${r.qty}</div>
      </div>`).join('');
  }
  function renderReport(){
    renderReportChips();
    renderReportStats();
    renderReportByPlatform();
    renderReportTopProducts();
  }

  function reportRangeLabel(){
    return REPORT_RANGES.find(r=>r.key===reportRange)?.label || reportRange;
  }

  document.getElementById('exportCsvBtn').addEventListener('click', ()=>{
    const entries = reportEntries();
    if(!entries.length){ showToast("Nothing to export in this range"); return; }
    const header = ["Date","Time","Type","Product","Barcode","Platform / Reason","Qty"];
    const rows = entries.map(e=>{
      const d = new Date(e.ts);
      return [
        d.toLocaleDateString(),
        d.toLocaleTimeString(),
       e.type === 'inward' ? 'Inward' :
e.type === 'return' ? 'Return' : 'Sale',
        e.name,
        e.barcode,
        e.type === 'inward' ? (e.reason||'') : (e.platform||''),
        e.qty
      ];
    });
    const csv = [header, ...rows].map(r => r.map(f => `"${String(f).replace(/"/g,'""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tlm-report-${reportRange}-${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast("CSV downloaded");
  });

  document.getElementById('sendReportSlackBtn').addEventListener('click', async ()=>{
    const fb = document.getElementById('reportFeedback');
    fb.innerHTML = '';
    if(!slackConfig.webhookUrl){
      fb.innerHTML = `<div class="not-found" style="margin-top:14px;"><h3>No Slack connected</h3><p>Add a webhook URL on the Platforms tab first.</p></div>`;
      return;
    }
    const entries = reportEntries();
    const sold = entries.filter(e=>e.type!=='inward');
    const inward = entries.filter(e=>e.type==='inward');
    const soldQty = sold.reduce((s,e)=>s+e.qty,0);
    const inwardQty = inward.reduce((s,e)=>s+e.qty,0);
    const byPlatform = {};
    sold.forEach(e=> byPlatform[e.platform] = (byPlatform[e.platform]||0) + e.qty);
    const platformLines = Object.entries(byPlatform).sort((a,b)=>b[1]-a[1])
      .map(([p,q])=> `• ${p}: ${q}`).join('\n') || '• No sales';
    const text = `📊 *TLM Inventory — ${reportRangeLabel()} report*\nUnits sold: *${soldQty}*\nUnits restocked: *${inwardQty}*\n\n*By platform:*\n${platformLines}`;
    const result = await sendSlackMessage(text);
    if(result.ok){
      showToast("Report sent to Slack");
    }else{
      fb.innerHTML = `<div class="not-found" style="margin-top:14px;"><h3>Couldn't send</h3><p>Check the Slack webhook on the Platforms tab.</p></div>`;
    }
  });


  function renderPlatformsScreen(){
    const list = document.getElementById('platformList');
    if(!platforms.length){
      list.innerHTML = `<div class="empty-state">No platforms yet — add the marketplaces you sell on.</div>`;
    }else{
      list.innerHTML = platforms.map(p=>`
        <div class="platform-chip">
          <div class="pname">${escapeHtml(p)}</div>
          <button class="icon-btn" data-p="${escapeHtml(p)}" title="Remove">✕</button>
        </div>`).join('');
      list.querySelectorAll('.icon-btn').forEach(btn=>{
        btn.addEventListener('click', async ()=>{
          const name = btn.dataset.p;
          if(platforms.length <= 1){ showToast("Keep at least one platform"); return; }
          platforms = platforms.filter(p=>p!==name);
          await savePlatforms();
          render();
          showToast(`Removed ${name}`);
        });
      });
    }
    document.getElementById('slackWebhook').value = slackConfig.webhookUrl || '';
    document.getElementById('notifySale').checked = !!slackConfig.notifySale;
    document.getElementById('notifyInward').checked = !!slackConfig.notifyInward;
    document.getElementById('notifyLowStock').checked = !!slackConfig.notifyLowStock;
    renderBackupHint();
    renderTeamAccess();
  }
  document.getElementById('addPlatformBtn').addEventListener('click', async ()=>{
    const input = document.getElementById('newPlatform');
    const val = input.value.trim();
    if(!val) return;
    if(platforms.some(p=>p.toLowerCase()===val.toLowerCase())){ showToast("Already on your list"); return; }
    platforms.push(val);
    await savePlatforms();
    input.value = '';
    render();
    showToast(`Added ${val}`);
  });

  document.getElementById('saveSlackBtn').addEventListener('click', async ()=>{
    slackConfig.webhookUrl = document.getElementById('slackWebhook').value.trim();
    slackConfig.notifySale = document.getElementById('notifySale').checked;
    slackConfig.notifyInward = document.getElementById('notifyInward').checked;
    slackConfig.notifyLowStock = document.getElementById('notifyLowStock').checked;
    await saveSlackConfig();
    document.getElementById('slackFeedback').innerHTML = '';
    showToast("Slack settings saved");
  });

  document.getElementById('testSlackBtn').addEventListener('click', async ()=>{
    const url = document.getElementById('slackWebhook').value.trim();
    const fb = document.getElementById('slackFeedback');
    fb.innerHTML = '';
    if(!url){
      fb.innerHTML = `<div class="not-found" style="margin-top:14px;"><h3>Add a webhook URL first</h3><p>Paste your Slack Incoming Webhook URL above, then try again.</p></div>`;
      return;
    }
    const prevUrl = slackConfig.webhookUrl;
    slackConfig.webhookUrl = url;
    const result = await sendSlackMessage("✅ TLM Inventory is now connected to this channel.");
    if(result.ok){
      showToast("Test message sent — check Slack");
    }else{
      slackConfig.webhookUrl = prevUrl;
      fb.innerHTML = `<div class="not-found" style="margin-top:14px;"><h3>Couldn't reach Slack</h3><p>Double check the webhook URL, and make sure this page is opened in your phone/desktop browser rather than an embedded app view.</p></div>`;
    }
  });

  // ---------- Backup & Restore ----------
  function renderBackupHint(){
    const el = document.getElementById('lastBackupHint');
    el.textContent = lastBackupTs
      ? `Last backup: ${new Date(lastBackupTs).toLocaleString()}`
      : 'No backup exported yet.';
  }

  function readFileAsText(file){
    return new Promise((resolve, reject)=>{
      const r = new FileReader();
      r.onload = ()=> resolve(r.result);
      r.onerror = ()=> reject(r.error);
      r.readAsText(file);
    });
  }

  document.getElementById('exportBackupBtn').addEventListener('click', async ()=>{
    const backup = {
      app: 'TLM Inventory',
      exportedAt: Date.now(),
      products, platforms, salesLog, slackConfig
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tlm-inventory-backup-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    lastBackupTs = Date.now();
    try{ await window.storage.set('last-backup-ts', JSON.stringify(lastBackupTs), false); }catch(e){}
    renderBackupHint();
    showToast("Backup downloaded");
  });

  document.getElementById('importBackupBtn').addEventListener('click', ()=>{
    document.getElementById('importBackupFile').click();
  });

  document.getElementById('importBackupFile').addEventListener('change', async (e)=>{
    const file = e.target.files[0];
    if(!file) return;
    const fb = document.getElementById('backupFeedback');
    fb.innerHTML = '';
    try{
      const text = await readFileAsText(file);
      const data = JSON.parse(text);
      if(!Array.isArray(data.products) || !Array.isArray(data.platforms)){
        throw new Error('unexpected file shape');
      }
      pendingImport = data;
      const logCount = Array.isArray(data.salesLog) ? data.salesLog.length : 0;
      fb.innerHTML = `
        <div class="result-card">
          <h3>Restore this backup?</h3>
          <div class="stock-line">
            Exported ${data.exportedAt ? new Date(data.exportedAt).toLocaleString() : 'unknown date'}<br>
            ${data.products.length} products · ${data.platforms.length} platforms · ${logCount} log entries
          </div>
          <p style="font-size:12.5px;color:var(--muted);margin-bottom:14px;">This replaces everything currently in the app on this device. This can't be undone.</p>
          <div class="btn-row">
            <button class="btn btn-outline" id="cancelImportBtn">Cancel</button>
            <button class="btn btn-danger" id="confirmImportBtn">Replace &amp; restore</button>
          </div>
        </div>`;
      document.getElementById('cancelImportBtn').addEventListener('click', ()=>{
        pendingImport = null;
        fb.innerHTML = '';
        document.getElementById('importBackupFile').value = '';
      });
      document.getElementById('confirmImportBtn').addEventListener('click', async ()=>{
        products = pendingImport.products || [];
        platforms = (pendingImport.platforms && pendingImport.platforms.length) ? pendingImport.platforms : DEFAULT_PLATFORMS.slice();
        salesLog = pendingImport.salesLog || [];
        if(pendingImport.slackConfig) slackConfig = pendingImport.slackConfig;
        await saveProducts();
        await savePlatforms();
        await saveLog();
        await saveSlackConfig();
        pendingImport = null;
        fb.innerHTML = '';
        document.getElementById('importBackupFile').value = '';
        showToast("Backup restored");
        render();
      });
    }catch(err){
      fb.innerHTML = `<div class="not-found" style="margin-top:14px;"><h3>Couldn't read that file</h3><p>Make sure it's a backup exported from this app.</p></div>`;
      document.getElementById('importBackupFile').value = '';
    }
  });

  document.getElementById('resetDataBtn').addEventListener('click', ()=>{
    const fb = document.getElementById('resetDataFeedback');
    fb.innerHTML = `
      <div class="lock-reset-confirm">
        <p>This clears every product, stock count, and sale/inward entry — everything shown across Scan, Inventory, Log, and Report goes back to zero. Your platforms, Slack settings, and logins stay as they are. Export a backup first if you want to keep a copy.</p>
        <input type="text" id="resetDataConfirmInput" placeholder='Type CLEAR to confirm'>
        <div class="btn-row">
          <button class="btn btn-ghost btn-sm" id="cancelResetDataBtn">Cancel</button>
          <button class="btn btn-danger btn-sm" id="confirmResetDataBtn">Clear everything</button>
        </div>
      </div>`;
    document.getElementById('cancelResetDataBtn').addEventListener('click', ()=>{ fb.innerHTML = ''; });
    document.getElementById('confirmResetDataBtn').addEventListener('click', async ()=>{
      if(document.getElementById('resetDataConfirmInput').value.trim() !== 'CLEAR'){
        showToast('Type CLEAR exactly to confirm');
        return;
      }
      products = [];
      salesLog = [];
      await saveProducts();
      await saveLog();
      fb.innerHTML = '';
      showToast('Inventory data cleared — starting fresh');
      render();
    });
  });

  // ---------- Add product screen ----------
  document.getElementById('saveProductBtn').addEventListener('click', async ()=>{
    const barcode = document.getElementById('addBarcode').value.trim();
    const name = document.getElementById('addName').value.trim();
    const threshold = parseInt(document.getElementById('addThreshold').value, 10);
    const fb = document.getElementById('addFeedback');
    if(!barcode || !name){
      fb.innerHTML = `<div class="not-found" style="margin-top:14px;"><h3>Missing details</h3><p>Barcode and product name are both required.</p></div>`;
      return;
    }
    if(!isValidEAN13(barcode)){
      fb.innerHTML = `<div class="not-found" style="margin-top:14px;"><h3>Not a valid barcode</h3><p>Only 13-digit EAN barcodes are supported.</p></div>`;
      return;
    }
    if(products.some(p=>p.barcode===barcode)){
      fb.innerHTML = `<div class="not-found" style="margin-top:14px;"><h3>Barcode already exists</h3><p>That barcode is already tracked in your inventory.</p></div>`;
      return;
    }
    products.push({ id: uid(), barcode, name, stock: 0, threshold: isNaN(threshold)?5:Math.max(0,threshold) });
    await saveProducts();
    fb.innerHTML = '';
    document.getElementById('addBarcode').value = '';
    document.getElementById('addName').value = '';
    document.getElementById('addThreshold').value = '';
    stopAddScanning();
    showToast(`Saved ${name} — scan it under Inward / Return to bring in stock`);
    render();
  });

  async function startAddScanning(){
    try{
      addHtml5Qrcode = new Html5Qrcode("addReader");
      await addHtml5Qrcode.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 240, height: 130 }, formatsToSupport: [Html5QrcodeSupportedFormats.EAN_13] },
        (text)=>{
          document.getElementById('addBarcode').value = text.trim();
          if(navigator.vibrate) navigator.vibrate(60);
          stopAddScanning();
        },
        ()=>{}
      );
    }catch(e){ showToast("Camera unavailable — type the barcode instead"); }
  }
  async function stopAddScanning(){
    if(addHtml5Qrcode){
      try{ await addHtml5Qrcode.stop(); addHtml5Qrcode.clear(); }catch(e){}
      addHtml5Qrcode = null;
    }
    document.getElementById('addReader').innerHTML = '';
  }
  document.getElementById('scanForAddBtn').addEventListener('click', ()=>{
    if(addHtml5Qrcode) stopAddScanning(); else startAddScanning();
  });

  // ---------- Master render ----------
  function render(){
    renderPlatformSelect();
    renderReasonSelect();
    if(currentScreen === 'scan') renderTodaySummary();
    if(currentScreen === 'inventory') renderInventory();
    if(currentScreen === 'log'){ renderLogFilters(); renderLog(); }
    if(currentScreen === 'report') renderReport();
    if(currentScreen === 'platforms') renderPlatformsScreen();
    if(currentScreen === 'account') renderAccount();
  }

  function renderAccount(){
    document.getElementById('accountEmail').textContent = currentUserEmail || '—';
    document.getElementById('accountRole').textContent = currentUserIsOwner ? 'Owner' : 'Team member';
  }
  document.getElementById('logoutBtn').addEventListener('click', ()=>{
    stopScanning();
    stopAddScanning();
    currentUserEmail = null;
    currentUserIsOwner = false;
    currentUserPermissions = { ...NO_PERMISSIONS };
    lockMode = 'login';
    goTo('scan');
    document.getElementById('lockScreen').classList.remove('hidden');
    setLockFieldsForMode();
  });

  // ---------- Init ----------
  function setLockFieldsForMode(){
    const emailInput = document.getElementById('lockEmailInput');
    const pwInput = document.getElementById('lockPasswordInput');
    const pwConfirm = document.getElementById('lockPasswordConfirm');
    const hint = document.getElementById('lockPasswordHint');
    const subtitle = document.getElementById('lockSubtitle');
    const submitBtn = document.getElementById('lockSubmitBtn');
    emailInput.value = '';
    emailInput.style.display = '';
    if(lockMode === 'login'){
      subtitle.textContent = "Enter your email and password to continue.";
      pwInput.style.display = ''; pwInput.value = '';
      pwConfirm.style.display = 'none';
      hint.style.display = 'none';
      submitBtn.textContent = "Log in";
    }else if(lockMode === 'setup'){
      subtitle.textContent = "Create the owner account for this app.";
      pwInput.style.display = '';
      pwConfirm.style.display = '';
      hint.style.display = '';
      hint.textContent = PASSWORD_HINT;
      submitBtn.textContent = "Create account";
      emailInput.value = 'sales@travellikesme.com';
      pwInput.value = 'Tlm2026!';
      pwConfirm.value = 'Tlm2026!';
    }else if(lockMode === 'migrate-email'){
      subtitle.textContent = "Add your email to your existing password to continue.";
      pwInput.style.display = 'none'; pwInput.value = '';
      pwConfirm.style.display = 'none';
      hint.style.display = 'none';
      submitBtn.textContent = "Continue";
      emailInput.value = 'sales@travellikesme.com';
    }
  }

  async function initLock(){
    let ac = null;
    try{
      const r = await window.storage.get('auth-config', false);
      ac = JSON.parse(r.value);
    }catch(e){ ac = null; }
    if(ac && Array.isArray(ac.users) && ac.users.length){
      authConfig = ac;
      lockMode = "login";
      setLockFieldsForMode();
      return;
    }
    let legacy = null;
    try{
      const r2 = await window.storage.get('app-lock', false);
      legacy = JSON.parse(r2.value);
    }catch(e){ legacy = null; }
    if(legacy && legacy.hash && legacy.salt){
      pendingMigration = legacy;
      lockMode = "migrate-email";
      setLockFieldsForMode();
      return;
    }
    lockMode = 'login';
    setLockFieldsForMode();
  }

  function lockError(msg){
    document.getElementById('lockError').innerHTML = `<div class="hint" style="color:var(--red); margin-top:10px;">${escapeHtml(msg)}</div>`;
    const card = document.querySelector('.lock-card');
    card.classList.remove('lock-shake');
    void card.offsetWidth;
    card.classList.add('lock-shake');
  }

  function tabAllowed(screen){
    if(currentUserIsOwner) return true;
    if(screen === 'account') return true;
    if(screen === 'platforms') return false;
    if(screen === 'scan') return currentUserPermissions.scanSale || currentUserPermissions.scanInward;
    if(screen === 'inventory') return !!currentUserPermissions.inventory;
    if(screen === 'log') return !!currentUserPermissions.log;
    if(screen === 'report') return !!currentUserPermissions.report;
    if(screen === 'add') return !!currentUserPermissions.add;
    return false;
  }

  function applyPermissionsToUI(){
    document.querySelectorAll('.tab-btn').forEach(btn=>{
      btn.style.display = tabAllowed(btn.dataset.screen) ? '' : 'none';
    });
    const saleBtn = document.querySelector('.mode-btn[data-mode="sale"]');
    const returnBtn = document.querySelector('.mode-btn[data-mode="return"]');
    const inwardBtn = document.querySelector('.mode-btn[data-mode="inward"]');
    const canSale = currentUserIsOwner || currentUserPermissions.scanSale;
    const canInward = currentUserIsOwner || currentUserPermissions.scanInward;

    saleBtn.style.display = canSale ? '' : 'none';
    returnBtn.style.display = canInward ? '' : 'none';
    inwardBtn.style.display = canInward ? '' : 'none';

    if(!canSale && canInward){
      scanMode = 'inward';
      document.querySelectorAll('.mode-btn').forEach(b=>b.classList.remove('active','inward-active'));
      inwardBtn.classList.add('inward-active');
      document.getElementById('platformSelectWrap').style.display = 'none';
      document.getElementById('inwardReasonWrap').style.display = '';
    }
    if(!tabAllowed(currentScreen)){
      const order = ['scan','inventory','log','report','add','account'];
      const fallback = order.find(s => tabAllowed(s)) || 'account';
      goTo(fallback);
    }
  }

  async function unlockApp(){
    lockMode = "unlocked";
    document.getElementById('lockScreen').classList.add('hidden');
    await loadAll();
    applyPermissionsToUI();
    render();
  }

  document.getElementById('lockSubmitBtn').addEventListener('click', async ()=>{
    const email = document.getElementById('lockEmailInput').value.trim().toLowerCase();
    const pw = document.getElementById('lockPasswordInput').value;
    const confirmPw = document.getElementById('lockPasswordConfirm').value;
    document.getElementById('lockError').innerHTML = '';

    if(!email || !isValidEmail(email)){ lockError("Enter a valid email address."); return; }

    if(lockMode === 'setup'){
      if(!passwordMeetsRequirements(pw)){ lockError("Password needs " + PASSWORD_HINT); return; }
      if(pw !== confirmPw){ lockError("Passwords don't match."); return; }
      const salt = genSalt();
      const hash = await hashPassword(pw, salt);
      authConfig = { users: [{ email, salt, hash, isOwner: true }] };
      try{
        await window.storage.set('auth-config', JSON.stringify(authConfig), false);
      }catch(e){ lockError("Couldn't save — try again."); return; }
      currentUserEmail = email; currentUserIsOwner = true; currentUserPermissions = { ...ALL_PERMISSIONS };
      unlockApp();
    }else if(lockMode === 'migrate-email'){
      authConfig = { users: [{ email, salt: pendingMigration.salt, hash: pendingMigration.hash, isOwner: true }] };
      try{
        await window.storage.set('auth-config', JSON.stringify(authConfig), false);
        await window.storage.delete('app-lock', false).catch(()=>{});
      }catch(e){ lockError("Couldn't save — try again."); return; }
      currentUserEmail = email; currentUserIsOwner = true; currentUserPermissions = { ...ALL_PERMISSIONS };
      unlockApp();
    }else if(lockMode === 'login'){
      if(!pw){ lockError("Enter your password."); return; }
      const user = authConfig.users.find(u => u.email === email);
      if(!user){ lockError("No account with that email."); return; }
      const testHash = await hashPassword(pw, user.salt);
      if(testHash === user.hash){
        currentUserEmail = user.email; currentUserIsOwner = !!user.isOwner;
        currentUserPermissions = user.isOwner ? { ...ALL_PERMISSIONS } : { ...NO_PERMISSIONS, ...(user.permissions || {}) };
        unlockApp();
      }else{
        lockError("Incorrect password.");
        document.getElementById('lockPasswordInput').value = '';
      }
    }
  });
  ['lockEmailInput','lockPasswordInput','lockPasswordConfirm'].forEach(id=>{
    document.getElementById(id).addEventListener('keydown', e=>{
      if(e.key === 'Enter') document.getElementById('lockSubmitBtn').click();
    });
  });

  document.getElementById('forgotPasswordBtn').addEventListener('click', ()=>{
    const err = document.getElementById('lockError');
    err.innerHTML = `
      <div class="lock-reset-confirm">
        <p>Forgetting the password means there's no way to recover it — this erases every product, log entry, and login on this device instead. If you have an exported backup file, you can restore it afterward.</p>
        <input type="text" id="resetConfirmInput" placeholder='Type RESET to confirm'>
        <div class="btn-row">
          <button class="btn btn-ghost btn-sm" id="cancelResetBtn">Cancel</button>
          <button class="btn btn-danger btn-sm" id="confirmResetBtn">Erase &amp; start over</button>
        </div>
      </div>`;
    document.getElementById('cancelResetBtn').addEventListener('click', ()=>{ err.innerHTML=''; });
    document.getElementById('confirmResetBtn').addEventListener('click', async ()=>{
      if(document.getElementById('resetConfirmInput').value.trim() !== 'RESET'){
        showToast('Type RESET exactly to confirm');
        return;
      }
      const keys = ['app-lock','auth-config','products','platforms','sales-log','slack-config','last-backup-ts'];
      for(const k of keys){
        try{ await window.storage.delete(k, false); }catch(e){ /* may not exist */ }
      }
      products = []; platforms = DEFAULT_PLATFORMS.slice(); salesLog = [];
      slackConfig = { webhookUrl:"", notifySale:false, notifyInward:false, notifyLowStock:false };
      lastBackupTs = null;
      authConfig = { users: [] };
      currentUserEmail = null; currentUserIsOwner = false;
      err.innerHTML = '';
      document.getElementById('lockPasswordInput').value = '';
      document.getElementById('lockPasswordConfirm').value = '';
      await initLock();
      showToast('Everything erased — set up a new owner account to start over');
    });
  });

  // ---------- Team Access & password settings (Platforms tab) ----------
  const PERMISSION_LABELS = {
    scanSale: "Scan sales",
    scanInward: "Scan inward/returns",
    inventory: "View inventory",
    log: "View log",
    report: "View reports",
    add: "Add products"
  };
  function renderTeamAccess(){
    const teamBlock = document.getElementById('teamAccessBlock');
    const dangerZone = document.getElementById('ownerDangerZone');
    const offNotice = document.getElementById('loginOffNotice');
    const loginActive = authConfig.users && authConfig.users.length > 0;

    if(!loginActive){
      teamBlock.style.display = 'none';
      dangerZone.style.display = 'none';
      offNotice.style.display = '';
      offNotice.textContent = "Login is off. The next time this app opens, it'll ask to set up a new owner account.";
      return;
    }
    offNotice.style.display = 'none';

    if(!currentUserIsOwner){
      teamBlock.style.display = 'none';
      dangerZone.style.display = 'none';
      return;
    }

    teamBlock.style.display = '';
    dangerZone.style.display = '';

    const list = document.getElementById('teamMemberList');
    if(!authConfig.users.length){
      list.innerHTML = `<div class="empty-state">No one added yet.</div>`;
    }else{
      list.innerHTML = authConfig.users.map(u=>{
        const permText = u.isOwner
          ? 'Full access'
          : (Object.keys(PERMISSION_LABELS).filter(k => u.permissions && u.permissions[k]).map(k=>PERMISSION_LABELS[k]).join(', ') || 'No access granted yet');
        return `
        <div class="platform-chip" style="align-items:flex-start;">
          <div>
            <div class="pname">${escapeHtml(u.email)}${u.isOwner ? ' <span style="color:var(--muted);font-weight:400;">(you, owner)</span>' : ''}</div>
            <div class="pmeta" style="margin-top:3px;">${escapeHtml(permText)}</div>
          </div>
          ${u.isOwner ? '' : `<button class="icon-btn" data-email="${escapeHtml(u.email)}" title="Remove">✕</button>`}
        </div>`;
      }).join('');
      list.querySelectorAll('.icon-btn').forEach(btn=>{
        btn.addEventListener('click', async ()=>{
          const email = btn.dataset.email;
          authConfig.users = authConfig.users.filter(u=>u.email!==email);
          try{ await window.storage.set('auth-config', JSON.stringify(authConfig), false); }catch(e){}
          showToast(`Removed access for ${email}`);
          render();
        });
      });
    }
  }

  document.getElementById('addMemberBtn').addEventListener('click', async ()=>{
    const fb = document.getElementById('teamAccessFeedback');
    fb.innerHTML = '';
    const email = document.getElementById('newMemberEmail').value.trim().toLowerCase();
    const pw = document.getElementById('newMemberPassword').value;
    const pwConfirm = document.getElementById('newMemberPasswordConfirm').value;
    if(!email || !isValidEmail(email)){ fb.innerHTML = `<div class="hint" style="color:var(--red);">Enter a valid email.</div>`; return; }
    if(authConfig.users.some(u=>u.email===email)){ fb.innerHTML = `<div class="hint" style="color:var(--red);">That email already has access.</div>`; return; }
    if(!passwordMeetsRequirements(pw)){ fb.innerHTML = `<div class="hint" style="color:var(--red);">Password needs ${PASSWORD_HINT}</div>`; return; }
    if(pw !== pwConfirm){ fb.innerHTML = `<div class="hint" style="color:var(--red);">Passwords don't match.</div>`; return; }
    const permissions = {
      scanSale: document.getElementById('permScanSale').checked,
      scanInward: document.getElementById('permScanInward').checked,
      inventory: document.getElementById('permInventory').checked,
      log: document.getElementById('permLog').checked,
      report: document.getElementById('permReport').checked,
      add: document.getElementById('permAdd').checked
    };
    const salt = genSalt();
    const hash = await hashPassword(pw, salt);
    authConfig.users.push({ email, salt, hash, isOwner: false, permissions });
    try{
      await window.storage.set('auth-config', JSON.stringify(authConfig), false);
    }catch(e){ fb.innerHTML = `<div class="hint" style="color:var(--red);">Couldn't save — try again.</div>`; return; }
    document.getElementById('newMemberEmail').value = '';
    document.getElementById('newMemberPassword').value = '';
    document.getElementById('newMemberPasswordConfirm').value = '';
    document.getElementById('permScanSale').checked = true;
    ['permScanInward','permInventory','permLog','permReport','permAdd'].forEach(id=>{ document.getElementById(id).checked = false; });
    showToast(`Access given to ${email}`);
    render();
  });

  document.getElementById('changePasswordBtn').addEventListener('click', async ()=>{
    const fb = document.getElementById('lockSettingsFeedback');
    fb.innerHTML = '';
    const cur = document.getElementById('curPassword').value;
    const next = document.getElementById('newPassword').value;
    const nextConfirm = document.getElementById('newPasswordConfirm').value;
    const user = authConfig.users.find(u => u.email === currentUserEmail);
    if(!user){ fb.innerHTML = `<div class="hint" style="color:var(--red);">Couldn't find your account — try logging in again.</div>`; return; }
    if(!cur){ fb.innerHTML = `<div class="hint" style="color:var(--red);">Enter your current password.</div>`; return; }
    if(!passwordMeetsRequirements(next)){ fb.innerHTML = `<div class="hint" style="color:var(--red);">New password needs ${PASSWORD_HINT}</div>`; return; }
    if(next !== nextConfirm){ fb.innerHTML = `<div class="hint" style="color:var(--red);">New passwords don't match.</div>`; return; }
    const testHash = await hashPassword(cur, user.salt);
    if(testHash !== user.hash){ fb.innerHTML = `<div class="hint" style="color:var(--red);">Current password is incorrect.</div>`; return; }
    const salt = genSalt();
    const hash = await hashPassword(next, salt);
    user.salt = salt; user.hash = hash;
    try{
      await window.storage.set('auth-config', JSON.stringify(authConfig), false);
    }catch(e){ fb.innerHTML = `<div class="hint" style="color:var(--red);">Couldn't update password — try again.</div>`; return; }
    document.getElementById('curPassword').value = '';
    document.getElementById('newPassword').value = '';
    document.getElementById('newPasswordConfirm').value = '';
    showToast("Password updated");
  });

  document.getElementById('removeLockBtn').addEventListener('click', async ()=>{
    const fb = document.getElementById('lockSettingsFeedback');
    fb.innerHTML = '';
    const cur = document.getElementById('curPassword').value;
    const owner = authConfig.users.find(u => u.email === currentUserEmail && u.isOwner);
    if(!owner){ fb.innerHTML = `<div class="hint" style="color:var(--red);">Only the owner can do this.</div>`; return; }
    if(!cur){ fb.innerHTML = `<div class="hint" style="color:var(--red);">Enter your current password to confirm.</div>`; return; }
    const testHash = await hashPassword(cur, owner.salt);
    if(testHash !== owner.hash){ fb.innerHTML = `<div class="hint" style="color:var(--red);">Current password is incorrect.</div>`; return; }
    authConfig = { users: [] };
    try{
      await window.storage.delete('auth-config', false);
    }catch(e){ /* ignore */ }
    document.getElementById('curPassword').value = '';
    showToast("Login turned off for everyone");
    render();
  });

  // ---------- Init ----------
  (async function init(){
    await initLock();
  })();

})();
