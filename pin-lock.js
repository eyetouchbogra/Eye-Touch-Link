/* Eye Touch Link — local app PIN gate (per device).
 * The PIN is PBKDF2-hashed; this is an app access gate, not database encryption.
 * Use only on HTTPS/localhost for Web Crypto.
 */
(() => {
  'use strict';
  const KEY = 'etl_device_pin_v1';
  // sessionStorage survives a page refresh but is cleared when the tab/session closes.
  const SESSION_KEY = 'etl_pin_unlocked_this_tab_v1';
  const $ = id => document.getElementById(id);
  let gate, unlocked = false, idleTimer = 0, currentMode = 'unlock';
  const IDLE_MS = 5 * 60 * 1000;

  const css = document.createElement('style');
  css.textContent = `
    #etlPinGate{position:fixed;inset:0;z-index:10001;background:#f1faf6;display:none;align-items:center;justify-content:center;padding:16px}
    #etlPinGate .etl-pin-card{width:min(100%,410px);background:#fff;border:1px solid #d8eee4;border-radius:18px;padding:24px;box-shadow:0 12px 40px #003d2e20}
    #etlPinGate h2{margin:0 0 8px;color:#003d2e}#etlPinGate input{width:100%;padding:13px;border:1px solid #cfe5d9;border-radius:9px;margin:7px 0 12px;font:inherit;letter-spacing:5px;text-align:center}
    #etlPinGate .pin-msg{min-height:24px;color:#b02b35;font-size:13px;margin:8px 0}#etlPinGate .pin-actions{display:flex;gap:8px;flex-wrap:wrap}
  `;
  document.head.appendChild(css);

  function record(){try{return JSON.parse(localStorage.getItem(KEY)||'null')}catch(_){return null}}
  function authVisible(){const a=$('etlAuthGate');return !!a && getComputedStyle(a).display!=='none'}
  function setMessage(s){$('etlPinMessage').textContent=s||''}
  function hex(buf){return Array.from(new Uint8Array(buf),b=>b.toString(16).padStart(2,'0')).join('')}
  async function hashPin(pin,saltHex){
    if(!window.crypto?.subtle) throw new Error('নিরাপদ PIN চালু করতে HTTPS ওয়েব ঠিকানা প্রয়োজন।');
    const salt=Uint8Array.from(saltHex.match(/.{2}/g),x=>parseInt(x,16));
    const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(pin),'PBKDF2',false,['deriveBits']);
    return hex(await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:210000,hash:'SHA-256'},key,256));
  }
  async function savePin(pin){const salt=crypto.getRandomValues(new Uint8Array(16));const saltHex=hex(salt);const hash=await hashPin(pin,saltHex);localStorage.setItem(KEY,JSON.stringify({version:1,salt:saltHex,hash,iterations:210000}));}
  function revealApp(){try{sessionStorage.setItem(SESSION_KEY,'1')}catch(_){}gate.style.display='none';unlocked=true;document.querySelector('.layout')?.style.removeProperty('visibility');document.querySelector('.top')?.style.removeProperty('visibility');const s=$('etlPinStatus');if(s)s.textContent='এই ডিভাইসে PIN চালু আছে।';resetIdle();}
  function showAppLock(){unlocked=false;try{sessionStorage.removeItem(SESSION_KEY)}catch(_){}gate.style.display='flex';document.querySelector('.layout')?.style.setProperty('visibility','hidden');document.querySelector('.top')?.style.setProperty('visibility','hidden');}
  function setMode(mode){currentMode=mode;const r=record();$('etlPinConfirmWrap').style.display=(mode==='setup'||mode==='new')?'block':'none';$('etlPinTitle').textContent=mode==='setup'?'এই ডিভাইসের জন্য নতুন ৪–১২ সংখ্যার PIN তৈরি করুন।':mode==='change'?'PIN পরিবর্তনের জন্য বর্তমান PIN দিন।':mode==='new'?'নতুন PIN দিন এবং নিশ্চিত করুন।':'আপনার PIN লিখুন।';$('etlPinLabel').textContent=mode==='change'?'বর্তমান PIN':mode==='new'?'নতুন PIN':'PIN';$('etlPinConfirmLabel').textContent='PIN আবার লিখুন';$('etlPinSubmit').textContent=mode==='setup'?'PIN সংরক্ষণ':mode==='change'?'যাচাই করুন':mode==='new'?'নতুন PIN সংরক্ষণ':'প্রবেশ করুন';$('etlPinInput').value='';$('etlPinConfirm').value='';$('etlPinInput').autocomplete='off';setMessage('');}
  function promptPin(mode){if(authVisible())return;showAppLock();setMode(mode);setTimeout(()=>$('etlPinInput').focus(),80);}
  async function submit(){const pin=$('etlPinInput').value.trim();if(!/^\d{4,12}$/.test(pin)){setMessage('৪ থেকে ১২ সংখ্যার PIN লিখুন।');return}const btn=$('etlPinSubmit');btn.disabled=true;try{
      if(currentMode==='setup'||currentMode==='new'){
        if(pin!==$('etlPinConfirm').value.trim()){setMessage('দুইবার দেওয়া PIN মিলেনি।');return}
        await savePin(pin);revealApp();return;
      }
      const r=record();if(!r){setMode('setup');return}
      if(await hashPin(pin,r.salt)!==r.hash){setMessage('PIN সঠিক নয়। আবার চেষ্টা করুন।');return}
      if(currentMode==='change'){setMode('new');return}
      revealApp();
    }catch(e){setMessage(e.message||'PIN যাচাই করা যায়নি।')}finally{btn.disabled=false}}
  function resetIdle(){clearTimeout(idleTimer);if(unlocked&&!authVisible())idleTimer=setTimeout(()=>promptPin('unlock'),IDLE_MS)}
  function init(){
    gate=document.createElement('div');gate.id='etlPinGate';gate.innerHTML=`<div class="etl-pin-card"><div style="display:flex;align-items:center;gap:12px;margin-bottom:16px"><img src="./icons/eye-touch-link-logo.svg" alt="" style="width:50px;height:50px"><div><h2>আই টাচৃ লিংক</h2><small>ডিভাইস PIN নিরাপত্তা</small></div></div><p id="etlPinTitle">আপনার PIN লিখুন।</p><label id="etlPinLabel" for="etlPinInput">PIN</label><input id="etlPinInput" type="password" inputmode="numeric" maxlength="12" placeholder="৪–১২ সংখ্যার PIN"><div id="etlPinConfirmWrap" style="display:none"><label id="etlPinConfirmLabel" for="etlPinConfirm">PIN আবার লিখুন</label><input id="etlPinConfirm" type="password" inputmode="numeric" maxlength="12" placeholder="একই PIN আবার লিখুন"></div><div id="etlPinMessage" class="pin-msg" aria-live="polite"></div><div class="pin-actions"><button id="etlPinSubmit" class="primary" type="button">প্রবেশ করুন</button></div><small style="display:block;margin-top:12px;color:#628176">PIN এই ডিভাইসেই সংরক্ষিত হয়। এটি Cloud-এ Sync হয় না।</small></div>`;
    document.body.appendChild(gate);$('etlPinSubmit').addEventListener('click',submit);$('etlPinInput').addEventListener('keydown',e=>{if(e.key==='Enter')submit()});$('etlPinConfirm').addEventListener('keydown',e=>{if(e.key==='Enter')submit()});
    $('etlPinChange')?.addEventListener('click',()=>promptPin(record()?'change':'setup'));
    $('etlPinLockNow')?.addEventListener('click',()=>promptPin('unlock'));
    const auth=$('etlAuthGate');
    const syncAuthState=()=>{
      // Cloud authentication must finish its initial session check before PIN logic runs.
      if(!window.etlAuthReady)return;
      if(authVisible()){clearTimeout(idleTimer);gate.style.display='none';unlocked=false;}
      else if(!unlocked){
        // Keep the current tab unlocked across F5/reload; a new tab/browser session must unlock.
        let tabWasUnlocked=false;try{tabWasUnlocked=sessionStorage.getItem(SESSION_KEY)==='1'}catch(_){}
        if(record()&&tabWasUnlocked)revealApp();else promptPin(record()?'unlock':'setup');
      }
    };
    if(auth){new MutationObserver(syncAuthState).observe(auth,{attributes:true,attributeFilter:['style','class']});}
    window.addEventListener('etl-auth-ready',syncAuthState);
    syncAuthState();
    ['pointerdown','keydown','touchstart'].forEach(ev=>document.addEventListener(ev,()=>{if(unlocked)resetIdle()},{passive:true}));
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'&&unlocked&&!authVisible()){clearTimeout(idleTimer);idleTimer=setTimeout(()=>promptPin('unlock'),IDLE_MS)}});
    const s=$('etlPinStatus');if(s)s.textContent=record()?'এই ডিভাইসে PIN চালু আছে।':'প্রথমবার Login-এর পর PIN তৈরি করুন।';
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
