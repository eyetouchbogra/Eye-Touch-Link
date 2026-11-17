/* Eye Touch Link Cloud Sync v1.2 — Google OAuth only
 * Keeps the existing localStorage ledger as the offline copy.
 * Cloud data is only replaced after explicit user confirmation and a backup.
 * Cross-device updates are checked periodically; unsaved local edits are never silently overwritten.
 */
(()=>{
  const $=id=>document.getElementById(id);
  const cfg=window.ETL_SUPABASE_CONFIG||{};
  const configured=!!(cfg.url&&cfg.anonKey&&cfg.anonKey!=='PASTE_SUPABASE_ANON_PUBLIC_KEY_HERE');
  const DEVICE_KEY='etl_device_id_v1',NAME_KEY='etl_device_name_v1';
  const FIRST_SYNC_KEY='etl_first_sync_choice_v1';
  const OFFLINE_GRANT_KEY='etl_offline_approved_v1';
  const OFFLINE_GRANT_TTL=30*24*60*60*1000; // refresh approval online at least once every 30 days
const bootLegacyGrant=(()=>{try{return JSON.parse(localStorage.getItem(OFFLINE_GRANT_KEY)||'null')}catch(_){return null}})();
const userOfflineGrantKey=userId=>`etl_offline_approved_v2:${userId}:${deviceId}`;
  const deviceId=(()=>{let x=localStorage.getItem(DEVICE_KEY);if(!x){x=(crypto.randomUUID?crypto.randomUUID():('etl-'+Date.now()+'-'+Math.random().toString(36).slice(2)));localStorage.setItem(DEVICE_KEY,x)}return x})();
  const platform=()=>/Android/i.test(navigator.userAgent)?'Android':/iPhone|iPad/i.test(navigator.userAgent)?'iOS':/Windows/i.test(navigator.userAgent)?'Windows':'Web';
  const deviceName=()=>localStorage.getItem(NAME_KEY)||(`${platform()} device`);
  let client=null,approved=false,saveTimer=null,cloudBusy=false,sessionReady=false,cloudVersion=null,lastSyncedSnapshot=null,pollBusy=false,loginInProgress=false;
  let currentUserId=null,loginResolvedUserId=null,offlineMode=false;
  const firstSyncDecisionKey=()=>currentUserId?`${FIRST_SYNC_KEY}:${currentUserId}:${deviceId}`:null;
  const saveFirstSyncDecision=value=>{const key=firstSyncDecisionKey();if(key)localStorage.setItem(key,value)};
  const status=(msg)=>{const n=$('cloudStatusText');if(n)n.textContent=msg;const h=$('localSaveLabel');if(h)h.textContent=msg.includes('Offline')||msg.includes('অফলাইন')?'● Offline':msg.includes('Sync')||msg.includes('সিঙ্ক')?'☁ Cloud Sync':'☁ '+msg.slice(0,24)};
  function readOfflineGrant(userId){
    try{
      if(userId){const scoped=JSON.parse(localStorage.getItem(userOfflineGrantKey(userId))||'null');if(scoped)return scoped;if(bootLegacyGrant?.userId===userId)return bootLegacyGrant;return null;}
      const active=localStorage.getItem('etl_active_user_id')||window.ETL_ACTIVE_USER_ID||bootLegacyGrant?.userId;
      return active?readOfflineGrant(active):bootLegacyGrant;
    }catch(_){return null}
  }
  function hasOfflineGrant(userId){const target=userId||localStorage.getItem('etl_active_user_id')||window.ETL_ACTIVE_USER_ID||bootLegacyGrant?.userId;const g=readOfflineGrant(target);return !!(g&&g.deviceId===deviceId&&g.userId===target&&Number(g.expiresAt)>Date.now())}
  function rememberOfflineApproval(userId){if(!userId)return;localStorage.setItem(userOfflineGrantKey(userId),JSON.stringify({userId,deviceId,approvedAt:Date.now(),expiresAt:Date.now()+OFFLINE_GRANT_TTL}))}
  function clearOfflineApproval(userId){if(userId){localStorage.removeItem(userOfflineGrantKey(userId));if(bootLegacyGrant?.userId===userId)localStorage.removeItem(OFFLINE_GRANT_KEY)}else localStorage.removeItem(OFFLINE_GRANT_KEY)}
  function enableOfflineMode(userId){
    const target=userId||localStorage.getItem('etl_active_user_id')||window.ETL_ACTIVE_USER_ID||bootLegacyGrant?.userId;
    if(!hasOfflineGrant(target))return false;
    const g=readOfflineGrant(target);
    offlineMode=true;approved=true;sessionReady=false;currentUserId=g.userId;loginResolvedUserId=null;
    gate(false);
    status('অফলাইন: এই অনুমোদিত ডিভাইসের লোকাল হিসাব চালু আছে। ইন্টারনেট এলে Sync হবে। ৩০ দিনের মধ্যে অনলাইনে যাচাই করুন।');
    ['cloudRefreshDevices','cloudReloadData','cloudPushData','cloudSignOut','etlRecoveryCreate','etlRecoveryCopy','cloudSaveDeviceName'].forEach(id=>{const b=$(id);if(b)b.disabled=true});
    window.addEventListener('online',()=>{status('ইন্টারনেট ফিরেছে; Cloud Sync যাচাই হচ্ছে…');setTimeout(()=>location.reload(),500)},{once:true});
    return true;
  }
  const gate=(show)=>{const g=$('etlAuthGate');if(g)g.style.display=show?'flex':'none';const layout=document.querySelector('.layout'),top=document.querySelector('.top');if(layout)layout.style.visibility=show?'hidden':'visible';if(top)top.style.visibility=show?'hidden':'visible'};
  const authMessage=(m)=>{if($('etlAuthMessage'))$('etlAuthMessage').textContent=m};
  function updateIdentityStatus(user){
    const el=$('cloudIdentityStatus');
    if(!el)return;
    if(!user){el.textContent='এই ডিভাইসে Google Login করা হয়নি।';return;}
    const providers=new Set([...(user.identities||[]).map(x=>x.provider),user.app_metadata?.provider].filter(Boolean));
    el.textContent=(user.email?('Google Account: '+user.email):'Google Account পাওয়া যায়নি')+' · '+(providers.has('google')?'Google Login সংযুক্ত':'Google পরিচয় যাচাই হয়নি');
  }
  const showArea=(which)=>{['etlLoginFields','etlPendingArea','etlDeniedArea'].forEach(id=>{if($(id))$(id).style.display=id===which?'block':'none'});const recovery=$('etlRecoveryClaimArea');if(recovery)recovery.style.display=(which==='etlPendingArea'||which==='etlDeniedArea')?'block':'none'};
  const rpc=async(name,args)=>{const {data,error}=await client.rpc(name,args);if(error)throw error;return data};
  const RECOVERY_ALPHABET='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function makeRecoveryCode(){
    if(!window.crypto?.getRandomValues)throw new Error('এই ব্রাউজারে নিরাপদ Recovery Code তৈরি করা যাচ্ছে না।');
    const bytes=new Uint8Array(24);window.crypto.getRandomValues(bytes);
    const raw=Array.from(bytes,b=>RECOVERY_ALPHABET[b&31]).join('');
    return raw.match(/.{1,4}/g).join('-');
  }
  function normaliseRecoveryCode(value){return String(value||'').toUpperCase().replace(/[^A-Z2-9]/g,'')}
  async function recoveryHash(value){
    if(!window.crypto?.subtle)throw new Error('নিরাপদ Hash তৈরির জন্য HTTPS সংযোগ প্রয়োজন।');
    const normalized=normaliseRecoveryCode(value);
    if(normalized.length!==24)throw new Error('Recovery Code-এর ২৪টি অক্ষর ঠিকভাবে লিখুন।');
    const digest=await window.crypto.subtle.digest('SHA-256',new TextEncoder().encode(normalized));
    return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
  }
  async function refreshRecoveryStatus(){
    const el=$('etlRecoveryStatus');if(!el||!approved||!client)return;
    try{
      const exists=await rpc('etl_recovery_status',{p_device_id:deviceId});
      el.textContent=exists?'Recovery Code তৈরি আছে। জরুরি প্রয়োজনে একবার ব্যবহার করা যাবে।':'এখনো Recovery Code তৈরি করা হয়নি। এখনই একটি তৈরি করে নিরাপদ স্থানে রাখুন।';
    }catch(e){el.textContent='Recovery সুবিধা প্রস্তুত হয়নি। Supabase Recovery SQL চালানো হয়েছে কি না পরীক্ষা করুন।';console.warn('Recovery status:',e.message)}
  }
  async function createRecoveryCode(){
    if(!approved)return alert('Recovery Code তৈরি করতে অনুমোদিত ডিভাইসে Login থাকতে হবে।');
    const btn=$('etlRecoveryCreate');const old=btn?.textContent;
    if(btn){btn.disabled=true;btn.textContent='নিরাপদ কোড তৈরি হচ্ছে...'}
    try{
      let exists=false;
      try{exists=await rpc('etl_recovery_status',{p_device_id:deviceId})}catch(e){throw new Error('Recovery SQL এখনো চালানো হয়নি অথবা সংযোগ সমস্যা: '+e.message)}
      if(exists&&!confirm('নতুন Recovery Code তৈরি করলে আগের Recovery Code সঙ্গে সঙ্গে বাতিল হবে। নতুন কোডটি নিরাপদে সংরক্ষণ করবেন তো?'))return;
      const code=makeRecoveryCode();
      const hash=await recoveryHash(code);
      await rpc('etl_set_recovery_code',{p_device_id:deviceId,p_code_hash:hash});
      const box=$('etlRecoveryCodeBox'),input=$('etlRecoveryCodeValue');
      if(input)input.value=code;
      if(box)box.style.display='block';
      const el=$('etlRecoveryStatus');if(el)el.textContent='নতুন Recovery Code তৈরি ও Cloud-এ সংরক্ষিত হয়েছে। কোডটি এখনই নিরাপদ স্থানে লিখে রাখুন।';
      alert('Recovery Code তৈরি হয়েছে। এটি শুধু এইবার দেখানো হচ্ছে। কোডটি কাগজে লিখে বা নিরাপদ Password Manager-এ রাখুন। কাউকে দেবেন না।');
    }catch(e){alert('Recovery Code তৈরি হয়নি: '+(e.message||e))}
    finally{if(btn){btn.disabled=false;btn.textContent=old||'Recovery Code তৈরি / নতুন কোড'}}
  }
  async function copyRecoveryCode(){
    const value=$('etlRecoveryCodeValue')?.value||'';if(!value)return;
    try{await navigator.clipboard.writeText(value);alert('Recovery Code কপি হয়েছে। নিরাপদ জায়গায় সংরক্ষণ করুন।')}
    catch(_){const input=$('etlRecoveryCodeValue');input.focus();input.select();alert('কোডটি নির্বাচন করা হয়েছে। Ctrl+C চাপুন।')}
  }
  async function recoverThisDevice(){
    const input=$('etlRecoveryClaimCode');const code=input?.value||'';
    if(!code.trim())return alert('আগে তৈরি করা Recovery Code লিখুন।');
    if(!confirm('Recovery Code একবার ব্যবহার হবে। সফল হলে এই অ্যাকাউন্টের অন্য সব ডিভাইসের অনুমোদন বাতিল হবে। Cloud-এর হিসাব মুছবে না। এই ডিভাইসটি চালু করবেন?'))return;
    const btn=$('etlRecoveryClaimBtn');const old=btn?.textContent;
    if(btn){btn.disabled=true;btn.textContent='Recovery যাচাই হচ্ছে...'}
    try{
      const hash=await recoveryHash(code);
      const result=await rpc('etl_recover_device',{p_device_id:deviceId,p_code_hash:hash});
      if(result==='RECOVERED'){
        if(input)input.value='';
        // Clear any earlier in-memory approval result before re-running login.
        // This also covers a device that was approved earlier in this same tab
        // and subsequently revoked from another device.
        approved=false;
        sessionReady=false;
        loginResolvedUserId=null;
        alert('Recovery সফল হয়েছে। এই ডিভাইস অনুমোদিত হয়েছে। এখন Cloud-এর হিসাব আনা হচ্ছে। পুরোনো ডিভাইসগুলো আবার অনুমোদন করতে হবে।');
        await finishLogin();
      }else if(result==='INVALID')alert('Recovery Code সঠিক নয়। আবার দেখে লিখুন।');
      else if(result==='LOCKED')alert('নিরাপত্তার কারণে Recovery সাময়িকভাবে ৩০ মিনিট বন্ধ আছে। পরে আবার চেষ্টা করুন।');
      else if(result==='NO_CODE')alert('এই অ্যাকাউন্টে Recovery Code তৈরি করা নেই, অথবা কোডটি আগে ব্যবহার হয়েছে।');
      else if(result==='NOT_PENDING')alert('এই ডিভাইসটি Recovery-এর অপেক্ষায় নেই। পেজ Refresh করে আবার চেষ্টা করুন।');
      else alert('Recovery সম্পন্ন হয়নি। আবার চেষ্টা করুন।');
    }catch(e){alert('Recovery ব্যর্থ: '+(e.message||e))}
    finally{if(btn){btn.disabled=false;btn.textContent=old||'Recovery Code দিয়ে এই ডিভাইস চালু করুন'}}
  }
  const localData=()=>window.etlGetDb?.()||null;
  const hasLocal=()=>{const d=localData();return !!(d&&(d.tx?.length||d.debts?.length||d.ledger?.length||d.people?.length))};
  // PostgreSQL JSONB may return object keys in a different order from
  // localStorage. Compare canonical JSON so equivalent ledgers are not
  // incorrectly treated as separate local and Cloud accounts.
  const stableSerialize=value=>{
    if(value===null || typeof value!=='object') return JSON.stringify(value);
    if(Array.isArray(value)) return '['+value.map(stableSerialize).join(',')+']';
    return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stableSerialize(value[key])).join(',')+'}';
  };
  const snapshot=d=>stableSerialize(d??null);
  const same=(a,b)=>snapshot(a)===snapshot(b);
  // Persist only a compact fingerprint of the last successfully synced data.
  // This lets each device identify whether local or Cloud changed after a reload.
  const SYNC_BASELINE_KEY='etl_sync_baseline_v1';
  const syncBaselineStorageKey=()=>currentUserId?`${SYNC_BASELINE_KEY}:${currentUserId}:${deviceId}`:null;
  function fingerprint(data){
    const value=snapshot(data);
    let h1=2166136261,h2=0x9e3779b9;
    for(let i=0;i<value.length;i++){
      const c=value.charCodeAt(i);
      h1=Math.imul(h1^c,16777619);
      h2=Math.imul(h2^c,2246822519);
    }
    return value.length+':'+(h1>>>0).toString(16)+':'+(h2>>>0).toString(16);
  }
  function readSyncBaseline(){
    const key=syncBaselineStorageKey();
    if(!key)return null;
    try{return JSON.parse(localStorage.getItem(key)||'null')}catch(_){return null}
  }
  function saveSyncBaseline(payload,updatedAt){
    const key=syncBaselineStorageKey();
    const hash=fingerprint(payload);
    if(key){
      try{localStorage.setItem(key,JSON.stringify({hash,updatedAt:updatedAt??null,savedAt:Date.now()}))}
      catch(e){console.warn('Could not persist Eye Touch Link sync baseline:',e.message)}
    }
    lastSyncedSnapshot=snapshot(payload);
    if(updatedAt!==undefined)cloudVersion=updatedAt;
  }
  function downloadJson(filename,data){const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;a.style.display='none';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),3000)}
  function backupLocal(){const d=localData();if(d)downloadJson('Eye-Touch-Link-local-backup-'+new Date().toISOString().slice(0,10)+'.json',d)}
  function backupCloud(d){if(d?.payload)downloadJson('Eye-Touch-Link-cloud-backup-'+new Date().toISOString().slice(0,10)+'.json',d.payload)}
  function applyCloud(d){
    window.etlSetDb(d.payload);
    sessionReady=true;
    saveSyncBaseline(d.payload,d.updated_at);
    status('অন্য ডিভাইসের হিসাব Sync হয়েছে');
  }
  async function refreshDevices() {
    const el = $('cloudDeviceList');
    const btn = $('cloudRefreshDevices');

    if (!el) return;

    if (!client) {
      el.textContent = 'Cloud সংযোগ প্রস্তুত হয়নি।';
      return;
    }

    if (!approved) {
      el.textContent = 'এই ডিভাইসের অনুমোদন যাচাই হয়নি।';
      return;
    }

    const oldText = btn?.textContent;
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'তালিকা আনা হচ্ছে...';
    }
    el.textContent = 'ডিভাইস তালিকা আনা হচ্ছে...';

    try {
      const rows = await rpc('etl_list_devices', {
        p_actor_device_id: deviceId
      });

      el.innerHTML = rows.map(d => `
        <div class="device-row">
          <div class="device-meta">
            <b>${escapeHtml(d.device_name)}
              ${d.device_id === deviceId ? '(এই ডিভাইস)' : ''}
            </b>
            <small>
              ${escapeHtml(d.platform)} · ${escapeHtml(d.status)}
              · শেষ ব্যবহার:
              ${d.last_seen_at
                ? new Date(d.last_seen_at).toLocaleString()
                : '—'}
            </small>
          </div>
          <div class="device-actions">
            ${d.status === 'pending'
              ? `<button class="primary"
                   data-approve-device="${escapeHtml(d.device_id)}">
                   অনুমোদন
                 </button>`
              : ''}
            ${d.status === 'approved' && d.device_id !== deviceId
              ? `<button class="danger"
                   data-revoke-device="${escapeHtml(d.device_id)}">
                   প্রবেশ বাতিল
                 </button>`
              : ''}
          </div>
        </div>
      `).join('') || '<div class="empty">কোনো ডিভাইস নেই।</div>';

      el.querySelectorAll('[data-approve-device]').forEach(b => {
        b.onclick = async () => {
          try {
            const ok = await rpc('etl_approve_device', {
              p_actor_device_id: deviceId,
              p_target_device_id: b.dataset.approveDevice
            });
            await refreshDevices();
            alert(ok
              ? 'ডিভাইস অনুমোদিত হয়েছে। নতুন ডিভাইসে “আবার যাচাই করুন” চাপুন।'
              : 'ডিভাইস অনুমোদন করা যায়নি; তালিকা রিফ্রেশ করুন।');
          } catch (e) {
            alert(e.message);
          }
        };
      });

      el.querySelectorAll('[data-revoke-device]').forEach(b => {
        b.onclick = async () => {
          if (!confirm('এই ডিভাইসের Cloud প্রবেশাধিকার বাতিল করবেন?')) return;
          try {
            await rpc('etl_revoke_device', {
              p_actor_device_id: deviceId,
              p_target_device_id: b.dataset.revokeDevice
            });
            await refreshDevices();
          } catch (e) {
            alert(e.message);
          }
        };
      });

    } catch (e) {
      el.textContent = 'ডিভাইস তালিকা পাওয়া যায়নি: ' + e.message;
      status('ডিভাইস তালিকা রিফ্রেশ ব্যর্থ: ' + e.message);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = oldText || 'ডিভাইস তালিকা রিফ্রেশ';
      }
    }
  }

  function escapeHtml(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
  async function resolveFirstSync(){
    const decisionKey=firstSyncDecisionKey();
    const previousChoice=decisionKey?localStorage.getItem(decisionKey):null;
    const cloud=await rpc('etl_get_cloud_data',{p_device_id:deviceId});
    const local=localData();

    if(!cloud){
      // First Cloud save for this account.
      const version=await rpc('etl_save_cloud_data',{p_device_id:deviceId,p_payload:local||{},p_expected_updated_at:null});
      sessionReady=true;
      saveSyncBaseline(local||{},version);
      saveFirstSyncDecision('resolved');
      status('প্রথম Cloud Backup সম্পন্ন');
      return;
    }

    cloudVersion=cloud.updated_at;

    if(!hasLocal()){
      applyCloud(cloud);
      saveFirstSyncDecision('resolved');
      status('Cloud হিসাব এই ডিভাইসে Sync হয়েছে');
      return;
    }

    if(same(local,cloud.payload)){
      sessionReady=true;
      saveSyncBaseline(local,cloud.updated_at);
      saveFirstSyncDecision('resolved');
      status('Cloud সিঙ্ক সম্পন্ন');
      return;
    }

    // Keep an explicit user choice to pause syncing, as before.
    if(previousChoice==='keep_local'){
      sessionReady=false;
      status('আপনার আগের সিদ্ধান্ত অনুযায়ী লোকাল হিসাব রাখা হয়েছে। Settings থেকে Cloud Sync/Restore নির্বাচন করুন।');
      return;
    }

    const baseline=readSyncBaseline();
    if(baseline?.hash){
      const localChanged=fingerprint(local)!==baseline.hash;
      const cloudChanged=fingerprint(cloud.payload)!==baseline.hash;

      if(localChanged && !cloudChanged){
        // Only this device changed: upload with the Cloud version we just read.
        const version=await rpc('etl_save_cloud_data',{
          p_device_id:deviceId,
          p_payload:local,
          p_expected_updated_at:cloud.updated_at
        });
        sessionReady=true;
        saveSyncBaseline(local,version);
        saveFirstSyncDecision('resolved');
        status('এই ডিভাইসের নতুন হিসাব স্বয়ংক্রিয়ভাবে Cloud-এ সংরক্ষিত হয়েছে');
        return;
      }

      if(!localChanged && cloudChanged){
        // Only Cloud changed: local still matches the last common version.
        applyCloud(cloud);
        saveFirstSyncDecision('resolved');
        status('অন্য ডিভাইসের নতুন হিসাব স্বয়ংক্রিয়ভাবে Sync হয়েছে');
        return;
      }

      if(localChanged && cloudChanged){
        sessionReady=false;
        status('দুই ডিভাইসে আলাদা পরিবর্তন হয়েছে। কোনো হিসাব মুছে ফেলা হয়নি; Settings থেকে তুলনা করে Sync নির্বাচন করুন।');
        return;
      }
    }

    // Migration for earlier v1.1 builds that stored only the word "resolved"
    // but did not persist a common sync baseline. The user had selected the
    // PC Cloud copy as the master; preserve a local backup and re-align to Cloud.
    if(previousChoice==='resolved'){
      backupLocal();
      applyCloud(cloud);
      saveFirstSyncDecision('resolved');
      status('আগের Sync মিলিয়ে নেওয়া হয়েছে; এখন স্বয়ংক্রিয় Sync চালু');
      return;
    }

    // First encounter of two different copies: ask rather than overwrite silently.
    const takeCloud=confirm(
      'এই অ্যাকাউন্টে Cloud হিসাব আছে এবং এই ডিভাইসেও আলাদা হিসাব আছে。\n\n'+
      'OK = Cloud হিসাব এই ডিভাইসে আনুন (লোকাল Backup ডাউনলোড হবে)。\n'+
      'Cancel = লোকাল হিসাব রাখুন; স্বয়ংক্রিয় Sync স্থগিত থাকবে。\n\n'+
      'দুই হিসাব একসঙ্গে মিশবে না。'
    );
    if(takeCloud){
      backupLocal();
      applyCloud(cloud);
      saveFirstSyncDecision('resolved');
      status('Cloud থেকে হিসাব আনা হয়েছে; স্বয়ংক্রিয় Sync চালু');
    }else{
      saveFirstSyncDecision('keep_local');
      sessionReady=false;
      status('লোকাল হিসাব রাখা হয়েছে — Cloud Sync স্থগিত।');
    }
  }
  async function finishLogin(){
    if(loginInProgress)return;
    loginInProgress=true;
    try{
    const {data:{user}}=await client.auth.getUser();
    updateIdentityStatus(user);
    if(!user){if(enableOfflineMode())return;currentUserId=null;gate(true);return}
    const providers=new Set([...(user.identities||[]).map(x=>x.provider),user.app_metadata?.provider].filter(Boolean));
    if(!providers.has('google')){
      authMessage('শুধু Google Login অনুমোদিত। Google Account দিয়ে আবার প্রবেশ করুন।');
      approved=false;sessionReady=false;currentUserId=null;loginResolvedUserId=null;
      await client.auth.signOut();gate(true);showArea('etlLoginFields');return;
    }
    if(loginResolvedUserId===user.id)return;
    currentUserId=user.id;
    let state;
    try{state=await rpc('etl_register_device',{p_device_id:deviceId,p_device_name:deviceName(),p_platform:platform()})}
    catch(e){if(enableOfflineMode(user.id))return;authMessage('ডিভাইস নিবন্ধন হয়নি: '+e.message);gate(true);return}
    if(state==='pending'){clearOfflineApproval(user.id);approved=false;sessionReady=false;showArea('etlPendingArea');authMessage('এই ডিভাইসটি আপনার অন্য অনুমোদিত ডিভাইস থেকে অনুমোদন করুন।');gate(true);return}
    if(state==='revoked'){clearOfflineApproval(user.id);approved=false;sessionReady=false;showArea('etlDeniedArea');authMessage('এই ডিভাইসের প্রবেশাধিকার বাতিল করা হয়েছে।');gate(true);return}
    approved=true;
    const mayClaimLegacy=!!(bootLegacyGrant&&bootLegacyGrant.userId===user.id&&bootLegacyGrant.deviceId===deviceId&&Number(bootLegacyGrant.expiresAt)>Date.now());
    try{
      if(typeof window.etlSwitchUserStorage!=='function')throw new Error('ব্যবহারকারীভিত্তিক Local হিসাব ব্যবস্থা পাওয়া যায়নি।');
      window.etlSwitchUserStorage(user.id,mayClaimLegacy);
      rememberOfflineApproval(user.id);offlineMode=false;
      await resolveFirstSync();
      loginResolvedUserId=user.id;
      gate(false);
      if($('cloudDeviceName'))$('cloudDeviceName').value=deviceName();
      await refreshDevices();
      await refreshRecoveryStatus();
    }catch(e){status('Cloud সংযোগ সমস্যা: '+e.message);sessionReady=false;gate(false);}
    }finally{loginInProgress=false}
  }
  async function signInGoogle(){
    const btn=$('etlGoogleLogin');
    if(!btn)return;
    const old=btn.textContent;
    btn.disabled=true;btn.textContent='Google-এ সংযোগ হচ্ছে…';
    authMessage('Google Login চালু হচ্ছে…');
    try{
      const {data,error}=await client.auth.signInWithOAuth({
        provider:'google',
        options:{
          redirectTo:location.origin+location.pathname,
          queryParams:{prompt:'select_account'},
          skipBrowserRedirect:true
        }
      });
      if(error)throw error;
      if(!data?.url)throw new Error('Google Login URL পাওয়া যায়নি।');
      // Navigate explicitly so mobile browsers do not remain on the
      // "Google Login চালু হচ্ছে" status without opening the provider.
      window.location.assign(data.url);
    }catch(e){
      authMessage('Google Login ব্যর্থ: '+(e.message||e));
      btn.disabled=false;btn.textContent=old;
    }
  }
  async function reloadCloud(){
    if(!approved)return;
    try{
      const c=await rpc('etl_get_cloud_data',{p_device_id:deviceId});
      if(!c)return alert('Cloud-এ এখনো কোনো হিসাব নেই।');
      if(!confirm('Cloud-এর হিসাব এই ডিভাইসে বসাবেন? OK দিলে বর্তমান লোকাল হিসাবের JSON Backup ডাউনলোড হবে। Cancel করলে কোনো পরিবর্তন হবে না。'))return;
      backupLocal();
      applyCloud(c);
      saveFirstSyncDecision('resolved');
      status('Cloud থেকে হিসাব আনা হয়েছে; স্বয়ংক্রিয় Sync চালু');
    }catch(e){alert('Cloud হিসাব আনা যায়নি: '+e.message)}
  }
  async function pushLocalToCloud(){
    if(!approved)return;
    try{
      const c=await rpc('etl_get_cloud_data',{p_device_id:deviceId});
      let version;
      if(c){
        if(!confirm('Cloud-এ আগে থেকে হিসাব আছে। OK দিলে Cloud হিসাবের Backup ডাউনলোড হবে এবং এরপর এই ডিভাইসের লোকাল হিসাব দিয়ে Cloud প্রতিস্থাপন হবে। Cancel করলে কোনো পরিবর্তন হবে না。'))return;
        backupCloud(c);
        version=await rpc('etl_save_cloud_data',{p_device_id:deviceId,p_payload:localData(),p_expected_updated_at:c.updated_at});
      }else{
        if(!confirm('Cloud-এ হিসাব নেই। এই ডিভাইসের লোকাল হিসাব প্রথমবার Cloud-এ সংরক্ষণ করবেন?'))return;
        version=await rpc('etl_save_cloud_data',{p_device_id:deviceId,p_payload:localData(),p_expected_updated_at:null});
      }
      sessionReady=true;
      saveSyncBaseline(localData(),version);
      saveFirstSyncDecision('resolved');
      status('লোকাল হিসাব Cloud-এ সংরক্ষিত হয়েছে; স্বয়ংক্রিয় Sync চালু');
    }catch(e){status('Cloud-এ পাঠানো যায়নি: '+e.message);alert('Cloud-এ পাঠানো যায়নি: '+e.message)}
  }
  async function checkRemote(){
    if(!client||!approved||!sessionReady||!navigator.onLine||pollBusy)return;
    pollBusy=true;
    try{
      const remote=await rpc('etl_get_cloud_data',{p_device_id:deviceId});
      if(!remote)return;
      if(remote.updated_at===cloudVersion)return;
      const local=localData();
      const baseline=readSyncBaseline();
      if(!baseline?.hash){
        if(lastSyncedSnapshot!==null && same(local,JSON.parse(lastSyncedSnapshot))){
          applyCloud(remote);
        }else{
          status('Cloud-এর আগের Sync ভিত্তি পাওয়া যায়নি; Settings থেকে একবার Cloud হিসাব আনুন।');
        }
        return;
      }
      const localChanged=fingerprint(local)!==baseline.hash;
      const cloudChanged=fingerprint(remote.payload)!==baseline.hash;
      if(!localChanged && cloudChanged){
        applyCloud(remote);
        status('অন্য ডিভাইসের নতুন হিসাব স্বয়ংক্রিয়ভাবে Sync হয়েছে');
      }else if(localChanged && !cloudChanged){
        // Cloud version changed but its data did not; retry local save against fresh version.
        cloudVersion=remote.updated_at;
        queueSave(local);
      }else if(localChanged && cloudChanged){
        status('দুই ডিভাইসে আলাদা পরিবর্তন হয়েছে। কোনো হিসাব মুছে ফেলা হয়নি; Settings থেকে তুলনা করে Sync নির্বাচন করুন।');
      }else{
        saveSyncBaseline(local,remote.updated_at);
      }
    }catch(e){if(navigator.onLine)console.warn('Cloud refresh:',e.message)}
    finally{pollBusy=false}
  }
  function queueSave(data){
    if(!configured||!client||!approved||!sessionReady)return;
    clearTimeout(saveTimer);
    saveTimer=setTimeout(async()=>{
      if(cloudBusy){queueSave(localData());return}
      cloudBusy=true;
      try{
        const payload=data??localData();
        const version=await rpc('etl_save_cloud_data',{
          p_device_id:deviceId,
          p_payload:payload,
          p_expected_updated_at:cloudVersion
        });
        sessionReady=true;
        saveSyncBaseline(payload,version);
        saveFirstSyncDecision('resolved');
        status('Cloud সিঙ্ক সম্পন্ন');
      }catch(e){
        const conflict=String(e.message||e).includes('CLOUD_CONFLICT');
        status(conflict?'অন্য ডিভাইসে একই সময়ে পরিবর্তন হয়েছে — কোনো হিসাব মুছে ফেলা হয়নি; Settings থেকে Sync নির্বাচন করুন':'অফলাইন / Sync অপেক্ষমাণ: '+(e.message||e));
        console.warn('Eye Touch Link cloud save:',e.message);
      }finally{cloudBusy=false}
    },900);
  }
  function setLoginButtonsEnabled(enabled){['etlGoogleLogin'].forEach(id=>{const b=$(id);if(b)b.disabled=!enabled})}
  function loadSupabaseFallback(src){return new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=src;script.async=true;script.onload=()=>resolve();script.onerror=()=>reject(new Error('লাইব্রেরি লোড হয়নি: '+src));document.head.appendChild(script);setTimeout(()=>reject(new Error('Supabase লাইব্রেরি লোড হতে সময় শেষ হয়েছে')),12000)})}
  async function init(){
    // Offline access is limited to this same device after a prior successful online approval.
    gate(true);showArea('etlLoginFields');authMessage('নিরাপদ Cloud Login প্রস্তুত হচ্ছে…');
    if(!navigator.onLine&&enableOfflineMode())return;
    if(!configured){authMessage('Cloud configuration পাওয়া যায়নি। supabase-config.js ও public key পরীক্ষা প্রয়োজন।');status('Cloud configuration অসম্পূর্ণ — Login বন্ধ');const el=$('cloudDeviceList');if(el)el.textContent='Supabase configuration সম্পূর্ণ না হওয়া পর্যন্ত Cloud Login চালু হবে না।';return}
    if(!window.supabase?.createClient){
      try{await loadSupabaseFallback('https://unpkg.com/@supabase/supabase-js@2');}catch(firstError){
        try{await loadSupabaseFallback('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2');}catch(secondError){
          if(enableOfflineMode())return;
          authMessage('Supabase Login লাইব্রেরি লোড হয়নি। প্রথমবার অনলাইনে প্রবেশ ও ডিভাইস অনুমোদন প্রয়োজন।');status('Cloud Login লাইব্রেরি পাওয়া যায়নি');console.error(firstError,secondError);return;
        }
      }
    }
    if(!window.supabase?.createClient){authMessage('Supabase লাইব্রেরি পাওয়া যায়নি। পেজ Refresh করুন।');status('Cloud Login লাইব্রেরি পাওয়া যায়নি');return}
    setLoginButtonsEnabled(true);
    client=window.supabase.createClient(cfg.url,cfg.anonKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
    $('etlGoogleLogin').onclick=signInGoogle;$('etlCheckApproval').onclick=finishLogin;$('etlTryAgain').onclick=finishLogin;
    $('cloudRefreshDevices').onclick=refreshDevices;$('cloudReloadData').onclick=reloadCloud;$('cloudPushData').onclick=pushLocalToCloud;if($('etlRecoveryCreate'))$('etlRecoveryCreate').onclick=createRecoveryCode;if($('etlRecoveryCopy'))$('etlRecoveryCopy').onclick=copyRecoveryCode;if($('etlRecoveryClaimBtn'))$('etlRecoveryClaimBtn').onclick=recoverThisDevice;$('cloudSignOut').onclick=async()=>{if(confirm('এই ডিভাইস থেকে লগআউট করবেন?')){clearOfflineApproval(currentUserId);await client.auth.signOut();location.reload()}};
    $('cloudSaveDeviceName').onclick=async()=>{const n=$('cloudDeviceName').value.trim();if(!n)return alert('ডিভাইসের নাম লিখুন।');localStorage.setItem(NAME_KEY,n);if(approved){try{await rpc('etl_register_device',{p_device_id:deviceId,p_device_name:n,p_platform:platform()});await refreshDevices();alert('ডিভাইসের নাম সংরক্ষিত হয়েছে।')}catch(e){alert(e.message)}}};
    const {data:{session}}=await client.auth.getSession();
    if(session){gate(true);authMessage('আপনার ডিভাইস যাচাই করা হচ্ছে...');await finishLogin()}else{showArea('etlLoginFields');gate(true);status('Login প্রয়োজন')}
    client.auth.onAuthStateChange((event,session)=>{if(event==='SIGNED_IN'&&session){setTimeout(()=>finishLogin().catch(e=>{authMessage('Login সমস্যা: '+e.message)}),0)}if(event==='SIGNED_OUT'){clearOfflineApproval(currentUserId);approved=false;sessionReady=false;currentUserId=null;loginResolvedUserId=null;gate(true)}});
    setInterval(checkRemote,15000);
    const recheck=async()=>{if(!approved||!navigator.onLine)return;try{const st=await rpc('etl_register_device',{p_device_id:deviceId,p_device_name:deviceName(),p_platform:platform()});if(st!=='approved'){approved=false;sessionReady=false;showArea(st==='revoked'?'etlDeniedArea':'etlPendingArea');authMessage('এই ডিভাইসের অনুমোদন আর সক্রিয় নেই।');gate(true)}}catch(e){console.warn('Device approval check:',e.message)}};
    window.addEventListener('online',()=>{recheck();checkRemote();if(approved&&sessionReady)queueSave(localData())});document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){recheck();checkRemote()}});
  }
  // Notify the local PIN gate only after the initial Cloud/Auth check has settled.
  // pin-lock.js waits for this signal before deciding whether to show the PIN screen.
  function markAuthReady(){
    if(window.etlAuthReady)return;
    window.etlAuthReady=true;
    window.dispatchEvent(new Event('etl-auth-ready'));
  }
  async function safeInit(){
    try{
      await init();
    }catch(e){
      if(enableOfflineMode())return;
      gate(true);showArea('etlLoginFields');
      authMessage('Cloud Login চালু হয়নি: '+(e?.message||e));
      status('Cloud Login-এ সমস্যা — হিসাব সুরক্ষিত রাখা হয়েছে');
      console.error('Eye Touch Link auth init:',e);
    }finally{
      markAuthReady();
    }
  }
  window.etlCloud={init:safeInit,queueSave,refreshDevices,deviceId};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',safeInit);else safeInit();
})();
