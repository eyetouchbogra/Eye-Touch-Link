/* Eye Touch Link Cloud Sync v1.2 — Automatic two-way reconciliation
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
  const deviceId=(()=>{let x=localStorage.getItem(DEVICE_KEY);if(!x){x=(crypto.randomUUID?crypto.randomUUID():('etl-'+Date.now()+'-'+Math.random().toString(36).slice(2)));localStorage.setItem(DEVICE_KEY,x)}return x})();
  const platform=()=>/Android/i.test(navigator.userAgent)?'Android':/iPhone|iPad/i.test(navigator.userAgent)?'iOS':/Windows/i.test(navigator.userAgent)?'Windows':'Web';
  const deviceName=()=>localStorage.getItem(NAME_KEY)||(`${platform()} device`);
  let client=null,approved=false,saveTimer=null,cloudBusy=false,sessionReady=false,pollEnabled=false,cloudVersion=null,lastSyncedSnapshot=null,pollBusy=false,loginInProgress=false;
  let currentUserId=null,loginResolvedUserId=null;
  const firstSyncDecisionKey=()=>currentUserId?`${FIRST_SYNC_KEY}:${currentUserId}:${deviceId}`:null;
  const baselineKey=()=>currentUserId?`etl_sync_baseline_v1:${currentUserId}:${deviceId}`:null;
  const saveBaseline=d=>{lastSyncedSnapshot=snapshot(d);const k=baselineKey();if(k)localStorage.setItem(k,lastSyncedSnapshot)};
  const loadBaseline=()=>{const k=baselineKey();if(!k)return null;try{return localStorage.getItem(k)}catch(_){return null}};
  const saveFirstSyncDecision=value=>{const key=firstSyncDecisionKey();if(key)localStorage.setItem(key,value)};
  // Three-way merge: preserve additions/edits/deletions made on either device since their last common snapshot.
  function mergeRecords(base,local,remote){
    if(Array.isArray(base)&&Array.isArray(local)&&Array.isArray(remote)){
      const allHaveIds=[...base,...local,...remote].every(x=>x&&typeof x==='object'&&!Array.isArray(x)&&x.id!=null);
      if(allHaveIds){
        const bm=new Map(base.map(x=>[String(x.id),x])),lm=new Map(local.map(x=>[String(x.id),x])),rm=new Map(remote.map(x=>[String(x.id),x]));
        const out=[];
        for(const id of new Set([...bm.keys(),...lm.keys(),...rm.keys()])){
          const hasB=bm.has(id),hasL=lm.has(id),hasR=rm.has(id),b=bm.get(id),l=lm.get(id),r=rm.get(id);
          if(!hasB){if(hasL&&hasR)out.push(mergeRecords(undefined,l,r));else if(hasL)out.push(l);else if(hasR)out.push(r);continue}
          if(!hasL&&!hasR)continue;
          if(!hasL){if(!same(r,b))out.push(r);continue}
          if(!hasR){if(!same(l,b))out.push(l);continue}
          out.push(mergeRecords(b,l,r));
        }
        return out;
      }
      if([...base,...local,...remote].every(x=>typeof x==='string'||typeof x==='number'||typeof x==='boolean')){
        const b=new Set(base),l=new Set(local),r=new Set(remote),all=new Set([...b,...l,...r]);
        return [...all].filter(x=>!b.has(x)?(l.has(x)||r.has(x)):(l.has(x)&&r.has(x)));
      }
      return same(local,base)?remote:(same(remote,base)?local:local);
    }
    if(base&&local&&remote&&typeof base==='object'&&typeof local==='object'&&typeof remote==='object'&&!Array.isArray(base)&&!Array.isArray(local)&&!Array.isArray(remote)){
      const out={};
      for(const k of new Set([...Object.keys(base),...Object.keys(local),...Object.keys(remote)])){
        const hasB=Object.prototype.hasOwnProperty.call(base,k),hasL=Object.prototype.hasOwnProperty.call(local,k),hasR=Object.prototype.hasOwnProperty.call(remote,k);
        const b=base[k],l=local[k],r=remote[k];
        if(!hasB){if(hasL&&hasR)out[k]=mergeRecords(undefined,l,r);else if(hasL)out[k]=l;else if(hasR)out[k]=r;continue}
        if(!hasL&&!hasR)continue;
        if(!hasL){if(!same(r,b))out[k]=r;continue}
        if(!hasR){if(!same(l,b))out[k]=l;continue}
        out[k]=mergeRecords(b,l,r);
      }
      return out;
    }
    return same(local,base)?remote:(same(remote,base)?local:local);
  }
  async function reconcileWithRemote(remote,local=localData()){
    const rawBase=loadBaseline();if(!rawBase)return null;let base;try{base=JSON.parse(rawBase)}catch(_){return null}
    const merged=mergeRecords(base,local||{},remote.payload||{});
    const version=await rpc('etl_save_cloud_data',{p_device_id:deviceId,p_payload:merged,p_expected_updated_at:remote.updated_at});
    cloudVersion=version;saveBaseline(merged);sessionReady=true;saveFirstSyncDecision('resolved');
    if(!same(local,merged))window.etlSetDb(merged);
    status('ফোন ও পিসির পরিবর্তন স্বয়ংক্রিয়ভাবে মিলিয়ে Sync হয়েছে');return merged;
  }
  const status=(msg)=>{const n=$('cloudStatusText');if(n)n.textContent=msg;const h=$('localSaveLabel');if(h)h.textContent=msg.includes('Sync')||msg.includes('সিঙ্ক')?'☁ Cloud Sync':msg.includes('Offline')||msg.includes('অফলাইন')?'● Offline':'☁ '+msg.slice(0,24)};
  const gate=(show)=>{const g=$('etlAuthGate');if(g)g.style.display=show?'flex':'none';const layout=document.querySelector('.layout'),top=document.querySelector('.top');if(layout)layout.style.visibility=show?'hidden':'visible';if(top)top.style.visibility=show?'hidden':'visible'};
  const authMessage=(m)=>{if($('etlAuthMessage'))$('etlAuthMessage').textContent=m};
  const showArea=(which)=>{['etlLoginFields','etlPendingArea','etlDeniedArea'].forEach(id=>{if($(id))$(id).style.display=id===which?'block':'none'})};
  const rpc=async(name,args)=>{const {data,error}=await client.rpc(name,args);if(error)throw error;return data};
  const localData=()=>window.etlGetDb?.()||null;
  const hasLocal=()=>{const d=localData();return !!(d&&(d.tx?.length||d.debts?.length||d.ledger?.length||d.people?.length))};
  const snapshot=d=>JSON.stringify(d??null);
  const same=(a,b)=>snapshot(a)===snapshot(b);
  function downloadJson(filename,data){const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;a.style.display='none';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),3000)}
  function backupLocal(){const d=localData();if(d)downloadJson('Eye-Touch-Link-local-backup-'+new Date().toISOString().slice(0,10)+'.json',d)}
  function backupCloud(d){if(d?.payload)downloadJson('Eye-Touch-Link-cloud-backup-'+new Date().toISOString().slice(0,10)+'.json',d.payload)}
  function applyCloud(d){window.etlSetDb(d.payload);cloudVersion=d.updated_at;saveBaseline(d.payload);status('অন্য ডিভাইসের হিসাব Sync হয়েছে')}
  async function refreshDevices(manual=false){
    const el=$('cloudDeviceList');
    if(!client){const msg='Cloud সংযোগ তৈরি হয়নি। পেজ রিফ্রেশ করে আবার চেষ্টা করুন।';if(el)el.textContent=msg;status(msg);return null;}
    if(!approved){const msg='এই ডিভাইসটি এখন অনুমোদিত অবস্থায় নেই। আবার লগইন যাচাই করুন।';if(el)el.textContent=msg;status(msg);return null;}
    if(!el)return null;
    if(manual){el.textContent='ডিভাইস তালিকা রিফ্রেশ হচ্ছে…';status('ডিভাইস তালিকা রিফ্রেশ হচ্ছে…');}
    try{
      const rows=await rpc('etl_list_devices',{p_actor_device_id:deviceId});
      if(!Array.isArray(rows))throw new Error('Supabase থেকে ডিভাইস তালিকার সঠিক ফল পাওয়া যায়নি।');
      el.innerHTML=rows.map(d=>`<div class="device-row"><div class="device-meta"><b>${escapeHtml(d.device_name)} ${d.device_id===deviceId?'(এই ডিভাইস)':''}</b><small>${escapeHtml(d.platform)} · ${escapeHtml(d.status)} · শেষ ব্যবহার: ${d.last_seen_at?new Date(d.last_seen_at).toLocaleString():'—'}</small></div><div class="device-actions">${d.status==='pending'?`<button class="primary" data-approve-device="${escapeHtml(d.device_id)}">অনুমোদন</button>`:''}${d.status==='approved'&&d.device_id!==deviceId?`<button class="danger" data-revoke-device="${escapeHtml(d.device_id)}">প্রবেশ বাতিল</button>`:''}</div></div>`).join('')||'<div class="empty">কোনো ডিভাইস নেই।</div>';
      el.querySelectorAll('[data-approve-device]').forEach(b=>b.onclick=async()=>{try{const ok=await rpc('etl_approve_device',{p_actor_device_id:deviceId,p_target_device_id:b.dataset.approveDevice});await refreshDevices();alert(ok?'ডিভাইস অনুমোদিত হয়েছে। নতুন ডিভাইসে “আবার যাচাই করুন” চাপুন।':'ডিভাইস অনুমোদন করা যায়নি; তালিকা রিফ্রেশ করুন।')}catch(e){alert(e.message)}});
      el.querySelectorAll('[data-revoke-device]').forEach(b=>b.onclick=async()=>{if(!confirm('এই ডিভাইসের Cloud প্রবেশাধিকার বাতিল করবেন?'))return;try{await rpc('etl_revoke_device',{p_actor_device_id:deviceId,p_target_device_id:b.dataset.revokeDevice});await refreshDevices()}catch(e){alert(e.message)}});
      if(manual){status(`ডিভাইস তালিকা আপডেট হয়েছে — ${rows.length}টি ডিভাইস`);}
      return rows;
    }catch(e){
      const msg='ডিভাইস তালিকা পাওয়া যায়নি: '+(e?.message||String(e));
      el.textContent=msg;status(msg);
      if(manual)alert(msg);
      return null;
    }
  }
  function escapeHtml(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
  async function resolveFirstSync(){
    const decisionKey=firstSyncDecisionKey();
    const previousChoice=decisionKey?localStorage.getItem(decisionKey):null;
    const savedBaseline=loadBaseline();
    if(savedBaseline){try{lastSyncedSnapshot=savedBaseline}catch(_){lastSyncedSnapshot=null}}
    const cloud=await rpc('etl_get_cloud_data',{p_device_id:deviceId});
    const local=localData();

    if(cloud){
      cloudVersion=cloud.updated_at;

      if(!hasLocal()){
        applyCloud(cloud);
        saveFirstSyncDecision('resolved');

      }else if(!same(local,cloud.payload)){
        // Remember the user's choice for this account on this device.
        // Cancel never downloads a backup and never replaces local data.
        if((previousChoice==='keep_local'||previousChoice==='resolved')&&savedBaseline){
          try{await reconcileWithRemote(cloud,local);return}catch(e){status('স্বয়ংক্রিয় Sync মিলানো যায়নি; আপনার দুই ডিভাইসের হিসাব নিরাপদ আছে: '+e.message);sessionReady=false;return}
        }
        if(previousChoice==='keep_local'){
          sessionReady=false;
          status('আগের লোকাল হিসাব রাখা হয়েছে। প্রথমবারের দুই হিসাব মিলাতে একবার Settings থেকে Sync নির্বাচন প্রয়োজন।');
          return;
        }
        if(previousChoice==='resolved'){
          sessionReady=false;
          status('দুই ডিভাইসের পুরোনো Sync ভিত্তি পাওয়া যায়নি। নিরাপদে রাখতে একবার Settings থেকে Sync নির্বাচন প্রয়োজন।');
          return;
        }

        const takeCloud=confirm('এই অ্যাকাউন্টে আগে থেকে Cloud হিসাব আছে এবং এই ডিভাইসেও আলাদা হিসাব আছে।\n\nOK = Cloud হিসাব এই ডিভাইসে আনুন (লোকাল হিসাবের Backup ডাউনলোড হবে)।\nCancel = লোকাল হিসাব রাখুন; কোনো Backup ডাউনলোড হবে না এবং Cloud-এ কিছু পাঠানো হবে না।\n\nদুই হিসাব একসঙ্গে মিশবে না।');

        if(takeCloud){
          backupLocal();
          applyCloud(cloud);
          saveFirstSyncDecision('resolved');
        }else{
          saveFirstSyncDecision('keep_local');
          sessionReady=false;
          status('লোকাল হিসাব রাখা হয়েছে — Cloud Sync স্থগিত। Settings থেকে পরে Cloud-এ পাঠাতে পারবেন।');
        }

      }else{
        saveBaseline(local);
        sessionReady=true;
        saveFirstSyncDecision('resolved');
        status('Cloud সিঙ্ক সম্পন্ন');
      }

    }else{
      // First cloud save for this account.
      cloudVersion=await rpc('etl_save_cloud_data',{p_device_id:deviceId,p_payload:local||{},p_expected_updated_at:null});
      saveBaseline(local);
      sessionReady=true;
      saveFirstSyncDecision('resolved');
      status('প্রথম Cloud Backup সম্পন্ন');
    }
  }
  async function finishLogin(){
    if(loginInProgress)return;
    loginInProgress=true;
    try{
    const {data:{user}}=await client.auth.getUser();
    if(!user){currentUserId=null;gate(true);return}
    if(loginResolvedUserId===user.id)return;
    currentUserId=user.id;
    let state;
    try{state=await rpc('etl_register_device',{p_device_id:deviceId,p_device_name:deviceName(),p_platform:platform()})}
    catch(e){authMessage('ডিভাইস নিবন্ধন হয়নি: '+e.message);gate(true);return}
    if(state==='pending'){approved=false;sessionReady=false;pollEnabled=false;showArea('etlPendingArea');authMessage('এই ডিভাইসটি আপনার অন্য অনুমোদিত ডিভাইস থেকে অনুমোদন করুন।');gate(true);return}
    if(state==='revoked'){approved=false;sessionReady=false;pollEnabled=false;showArea('etlDeniedArea');authMessage('এই ডিভাইসের প্রবেশাধিকার বাতিল করা হয়েছে।');gate(true);return}
    approved=true;
    pollEnabled=true; // Read-only polling stays active when local/cloud conflict pauses automatic writes.
    try{
      await resolveFirstSync();
      loginResolvedUserId=user.id;
      gate(false);
      if($('cloudDeviceName'))$('cloudDeviceName').value=deviceName();
      await refreshDevices();
    }catch(e){status('Cloud সংযোগ সমস্যা: '+e.message);sessionReady=false;gate(false);}
    }finally{loginInProgress=false}
  }
  async function sendEmail(){const email=$('etlLoginIdentity').value.trim();if(!/^\S+@\S+\.\S+$/.test(email))return authMessage('সঠিক Gmail / ইমেইল লিখুন।');const {error}=await client.auth.signInWithOtp({email,options:{emailRedirectTo:location.origin+location.pathname}});authMessage(error?'ইমেইল পাঠানো যায়নি: '+error.message:'আপনার Gmail-এ Login Link পাঠানো হয়েছে। ইমেইল খুলে একই ফোন/কম্পিউটারের এই ব্রাউজারে লিংকে চাপুন।')}
  async function sendPhone(){const phone=$('etlLoginIdentity').value.trim();if(!/^\+[1-9]\d{7,14}$/.test(phone))return authMessage('ফোন নম্বর আন্তর্জাতিক ফরম্যাটে লিখুন, যেমন +8801XXXXXXXXX');const {error}=await client.auth.signInWithOtp({phone});if(error)return authMessage('OTP পাঠানো যায়নি: '+error.message);$('etlOtpArea').style.display='block';$('etlOtp').dataset.kind='sms';$('etlOtp').dataset.identity=phone;authMessage('ফোনে OTP পাঠানো হয়েছে। কোড লিখে যাচাই করুন।')}
  async function verifyOtp(){const token=$('etlOtp').value.trim(),kind=$('etlOtp').dataset.kind,identity=$('etlOtp').dataset.identity;if(!token||!identity)return authMessage('OTP কোড লিখুন।');const args=kind==='sms'?{phone:identity,token,type:'sms'}:{email:identity,token,type:'email'};const {error}=await client.auth.verifyOtp(args);if(error)return authMessage('OTP যাচাই হয়নি: '+error.message);await finishLogin()}
  async function inspectCloudData(){
    if(!approved)return alert('এই ডিভাইসটি Cloud-এ অনুমোদিত নয়।');
    try{
      status('Cloud-এর হিসাব শুধু পড়া হচ্ছে...');
      const c=await rpc('etl_get_cloud_data',{p_device_id:deviceId});
      if(!c){alert('Cloud-এ এখনো কোনো হিসাব সংরক্ষিত নেই।');return}
      const d=c.payload||{};
      const payments=(d.debts||[]).reduce((n,x)=>n+(Array.isArray(x.payments)?x.payments.length:0),0);
      const additions=(d.debts||[]).reduce((n,x)=>n+(Array.isArray(x.additions)?x.additions.length:0),0);
      const holidays=(d.debts||[]).reduce((n,x)=>n+(Array.isArray(x.holidays)?x.holidays.length:0),0);
      const msg='Cloud-এ বর্তমানে সংরক্ষিত হিসাব (শুধু দেখা হয়েছে; কোনো পরিবর্তন হয়নি):\n\nলেনদেন: '+(d.tx||[]).length+'\nলোন/ধার হিসাব: '+(d.debts||[]).length+'\nকিস্তি/পেমেন্ট: '+payments+'\nঅতিরিক্ত লোন/ধার: '+additions+'\nছুটি/স্থগিত: '+holidays+'\nনামভিত্তিক লেজার: '+(d.ledger||[]).length+'\nব্যক্তি/নাম: '+(d.people||[]).length+'\n\nসর্বশেষ Cloud আপডেট: '+(c.updated_at?new Date(c.updated_at).toLocaleString():'তথ্য নেই');
      alert(msg);
      status('Cloud হিসাব যাচাই সম্পন্ন — কোনো ডেটা পরিবর্তন হয়নি');
    }catch(e){alert('Cloud হিসাব পড়া যায়নি: '+e.message);status('Cloud যাচাই ব্যর্থ: '+e.message)}
  }
  async function reloadCloud(){if(!approved)return;try{const c=await rpc('etl_get_cloud_data',{p_device_id:deviceId});if(!c)return alert('Cloud-এ এখনো কোনো হিসাব নেই।');if(!confirm('Cloud-এর হিসাব এই ডিভাইসে বসাবেন? OK দিলে বর্তমান লোকাল হিসাবের JSON Backup ডাউনলোড হবে। Cancel করলে কোনো পরিবর্তন বা Backup হবে না।'))return;backupLocal();window.etlSetDb(c.payload);cloudVersion=c.updated_at;saveBaseline(c.payload);sessionReady=true;saveFirstSyncDecision('resolved');status('Cloud থেকে হিসাব আনা হয়েছে')}catch(e){alert('Cloud হিসাব আনা যায়নি: '+e.message)}}
  async function pushLocalToCloud(){if(!approved)return;try{const c=await rpc('etl_get_cloud_data',{p_device_id:deviceId});if(c){if(!confirm('Cloud-এ আগে থেকে হিসাব আছে। OK দিলে Cloud হিসাবের Backup ডাউনলোড হবে এবং এরপর এই ডিভাইসের লোকাল হিসাব দিয়ে Cloud প্রতিস্থাপন হবে। Cancel করলে কোনো Backup বা পরিবর্তন হবে না।'))return;backupCloud(c);cloudVersion=await rpc('etl_save_cloud_data',{p_device_id:deviceId,p_payload:localData(),p_expected_updated_at:c.updated_at})}else{if(!confirm('Cloud-এ হিসাব নেই। এই ডিভাইসের লোকাল হিসাব প্রথমবার Cloud-এ সংরক্ষণ করবেন?'))return;cloudVersion=await rpc('etl_save_cloud_data',{p_device_id:deviceId,p_payload:localData(),p_expected_updated_at:null})}saveBaseline(localData());sessionReady=true;saveFirstSyncDecision('resolved');status('লোকাল হিসাব Cloud-এ সংরক্ষিত হয়েছে')}catch(e){status('Cloud-এ পাঠানো যায়নি: '+e.message);alert('Cloud-এ পাঠানো যায়নি: '+e.message)}}
  async function checkRemote(){if(!client||!approved||!pollEnabled||!navigator.onLine||pollBusy)return;pollBusy=true;try{const remote=await rpc('etl_get_cloud_data',{p_device_id:deviceId});if(!remote||remote.updated_at===cloudVersion)return;const local=localData();if(same(local,lastSyncedSnapshot)){applyCloud(remote);return}if(sessionReady&&lastSyncedSnapshot){try{await reconcileWithRemote(remote,local)}catch(e){status('অন্য ডিভাইসে পরিবর্তন হয়েছে; স্বয়ংক্রিয় মিলানোর চেষ্টা চলছে: '+e.message)}}else{status('প্রথম Sync সম্পন্ন করুন; কোনো হিসাব মুছে ফেলা হয়নি।')}}catch(e){if(navigator.onLine)console.warn('Cloud refresh:',e.message)}finally{pollBusy=false}}
  function queueSave(data){if(!configured||!client||!approved||!sessionReady)return;clearTimeout(saveTimer);saveTimer=setTimeout(async()=>{if(cloudBusy){queueSave(localData());return}cloudBusy=true;try{let payload=data;try{cloudVersion=await rpc('etl_save_cloud_data',{p_device_id:deviceId,p_payload:payload,p_expected_updated_at:cloudVersion})}catch(err){if(!String(err?.message||'').includes('CLOUD_CONFLICT'))throw err;const remote=await rpc('etl_get_cloud_data',{p_device_id:deviceId});if(!remote||!lastSyncedSnapshot)throw err;let base;try{base=JSON.parse(lastSyncedSnapshot)}catch(_){throw err}payload=mergeRecords(base,localData()||{},remote.payload||{});cloudVersion=await rpc('etl_save_cloud_data',{p_device_id:deviceId,p_payload:payload,p_expected_updated_at:remote.updated_at});if(!same(localData(),payload))window.etlSetDb(payload)}saveBaseline(payload);status('Cloud সিঙ্ক সম্পন্ন')}catch(e){status(e.message.includes('CLOUD_CONFLICT')?'অন্য ডিভাইসের পরিবর্তনের সঙ্গে Sync আটকে আছে; ডেটা মুছে ফেলা হয়নি':'অফলাইন / Sync অপেক্ষমাণ');console.warn('Eye Touch Link cloud save:',e.message)}finally{cloudBusy=false}},900)}
  async function linkEmail(){const email=$('cloudLinkEmail').value.trim();if(!/^\S+@\S+\.\S+$/.test(email))return alert('সঠিক Gmail লিখুন।');const {error}=await client.auth.updateUser({email});alert(error?'Gmail যুক্ত করার অনুরোধ ব্যর্থ: '+error.message:'Gmail-এ নিশ্চিতকরণ লিংক পাঠানো হয়েছে। লিংকে চাপ দিয়ে নিশ্চিত করুন।')}
  async function linkPhone(){const phone=$('cloudLinkPhone').value.trim();if(!/^\+[1-9]\d{7,14}$/.test(phone))return alert('আন্তর্জাতিক ফরম্যাটে নম্বর লিখুন, যেমন +8801XXXXXXXXX');const {error}=await client.auth.updateUser({phone});if(error)return alert('ফোন যুক্ত করার অনুরোধ ব্যর্থ: '+error.message);$('cloudLinkOtp').dataset.kind='phone_change';$('cloudLinkOtp').dataset.identity=phone;alert('ফোনে OTP পাঠানো হয়েছে। কোডটি লিখে OTP যাচাই চাপুন।')}
  async function verifyLinked(){const token=$('cloudLinkOtp').value.trim(),kind=$('cloudLinkOtp').dataset.kind,identity=$('cloudLinkOtp').dataset.identity;if(!token||!kind||!identity)return alert('আগে Gmail বা ফোন যুক্ত করার অনুরোধ পাঠান।');const args=kind==='phone_change'?{phone:identity,token,type:'phone_change'}:{email:identity,token,type:'email_change'};const {error}=await client.auth.verifyOtp(args);alert(error?'যাচাই হয়নি: '+error.message:'বিকল্প পরিচয় যুক্ত হয়েছে। এখন Gmail বা ফোন—দুটির যেকোনোটি দিয়ে একই Cloud অ্যাকাউন্টে প্রবেশ করা যাবে।')}
  async function init(){
    if(!configured||!window.supabase?.createClient){status('Cloud key সেটআপ বাকি — লোকাল হিসাব চালু');const el=$('cloudDeviceList');if(el)el.textContent='Supabase key / library সেটআপের পর Cloud Sync চালু হবে।';return}
    client=window.supabase.createClient(cfg.url,cfg.anonKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
    $('etlSendEmail').onclick=sendEmail;$('etlSendPhone').onclick=sendPhone;$('etlVerifyOtp').onclick=verifyOtp;$('etlCheckApproval').onclick=finishLogin;$('etlTryAgain').onclick=finishLogin;
    const diagBtn=document.createElement('button');diagBtn.type='button';diagBtn.className='secondary';diagBtn.textContent='Cloud-এ কী হিসাব আছে দেখুন';diagBtn.onclick=inspectCloudData;const reloadBtn=$('cloudReloadData');if(reloadBtn?.parentNode)reloadBtn.parentNode.insertBefore(diagBtn,reloadBtn);
    $('cloudRefreshDevices').addEventListener('click',async ev=>{ev.preventDefault();const b=$('cloudRefreshDevices');if(b.dataset.busy==='1')return;b.dataset.busy='1';b.disabled=true;const old=b.textContent;b.textContent='রিফ্রেশ হচ্ছে…';try{await refreshDevices(true)}finally{b.disabled=false;b.textContent=old;delete b.dataset.busy}});$('cloudReloadData').onclick=reloadCloud;$('cloudPushData').onclick=pushLocalToCloud;$('cloudSignOut').onclick=async()=>{if(confirm('এই ডিভাইস থেকে লগআউট করবেন?')){await client.auth.signOut();location.reload()}};
    $('cloudSaveDeviceName').onclick=async()=>{const n=$('cloudDeviceName').value.trim();if(!n)return alert('ডিভাইসের নাম লিখুন।');localStorage.setItem(NAME_KEY,n);if(approved){try{await rpc('etl_register_device',{p_device_id:deviceId,p_device_name:n,p_platform:platform()});await refreshDevices();alert('ডিভাইসের নাম সংরক্ষিত হয়েছে।')}catch(e){alert(e.message)}}};
    $('cloudLinkEmailBtn').onclick=linkEmail;$('cloudLinkPhoneBtn').onclick=linkPhone;$('cloudVerifyLinkBtn').onclick=verifyLinked;
    const {data:{session}}=await client.auth.getSession();
    if(session){gate(true);authMessage('আপনার ডিভাইস যাচাই করা হচ্ছে...');await finishLogin()}else{showArea('etlLoginFields');gate(true);status('Login প্রয়োজন')}
    client.auth.onAuthStateChange((event,session)=>{if(event==='SIGNED_IN'&&session){setTimeout(()=>finishLogin().catch(e=>{authMessage('Login সমস্যা: '+e.message)}),0)}if(event==='SIGNED_OUT'){approved=false;sessionReady=false;pollEnabled=false;currentUserId=null;loginResolvedUserId=null;gate(true)}});
    setInterval(checkRemote,15000);
    const recheck=async()=>{if(!approved||!navigator.onLine)return;try{const st=await rpc('etl_register_device',{p_device_id:deviceId,p_device_name:deviceName(),p_platform:platform()});if(st!=='approved'){approved=false;sessionReady=false;showArea(st==='revoked'?'etlDeniedArea':'etlPendingArea');authMessage('এই ডিভাইসের অনুমোদন আর সক্রিয় নেই।');gate(true)}}catch(e){console.warn('Device approval check:',e.message)}};
    window.addEventListener('online',()=>{recheck();checkRemote();if(approved&&sessionReady)queueSave(localData())});document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){recheck();checkRemote()}});
  }
  window.etlCloud={init,queueSave,refreshDevices,deviceId};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
