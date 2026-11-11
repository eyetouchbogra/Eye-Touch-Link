/* Eye Touch Link Cloud Sync v1.1
 * Keeps the existing localStorage ledger as the offline copy.
 * Cloud data is only replaced after explicit user confirmation and a backup.
 * Cross-device updates are checked periodically; unsaved local edits are never silently overwritten.
 */
(()=>{
  const $=id=>document.getElementById(id);
  const cfg=window.ETL_SUPABASE_CONFIG||{};
  const configured=!!(cfg.url&&cfg.anonKey&&cfg.anonKey!=='PASTE_SUPABASE_ANON_PUBLIC_KEY_HERE');
  const DEVICE_KEY='etl_device_id_v1',NAME_KEY='etl_device_name_v1';
  const deviceId=(()=>{let x=localStorage.getItem(DEVICE_KEY);if(!x){x=(crypto.randomUUID?crypto.randomUUID():('etl-'+Date.now()+'-'+Math.random().toString(36).slice(2)));localStorage.setItem(DEVICE_KEY,x)}return x})();
  const platform=()=>/Android/i.test(navigator.userAgent)?'Android':/iPhone|iPad/i.test(navigator.userAgent)?'iOS':/Windows/i.test(navigator.userAgent)?'Windows':'Web';
  const deviceName=()=>localStorage.getItem(NAME_KEY)||(`${platform()} device`);
  let client=null,approved=false,saveTimer=null,cloudBusy=false,sessionReady=false,cloudVersion=null,lastSyncedSnapshot=null,pollBusy=false,loginInProgress=false;
  const markAuthReady=()=>{window.etlAuthReady=true;window.dispatchEvent(new Event('etl-auth-ready'))};
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
  function applyCloud(d){window.etlSetDb(d.payload);cloudVersion=d.updated_at;lastSyncedSnapshot=snapshot(d.payload);sessionReady=true;status('অন্য ডিভাইসের হিসাব Sync হয়েছে')}
  async function refreshDevices(){
    if(!client||!approved)return;
    const el=$('cloudDeviceList');if(!el)return;
    try{
      const rows=await rpc('etl_list_devices',{p_actor_device_id:deviceId});
      el.innerHTML=rows.map(d=>`<div class="device-row"><div class="device-meta"><b>${escapeHtml(d.device_name)} ${d.device_id===deviceId?'(এই ডিভাইস)':''}</b><small>${escapeHtml(d.platform)} · ${escapeHtml(d.status)} · শেষ ব্যবহার: ${d.last_seen_at?new Date(d.last_seen_at).toLocaleString():'—'}</small></div><div class="device-actions">${d.status==='pending'?`<button class="primary" data-approve-device="${escapeHtml(d.device_id)}">অনুমোদন</button>`:''}${d.status==='approved'&&d.device_id!==deviceId?`<button class="danger" data-revoke-device="${escapeHtml(d.device_id)}">প্রবেশ বাতিল</button>`:''}</div></div>`).join('')||'<div class="empty">কোনো ডিভাইস নেই।</div>';
      el.querySelectorAll('[data-approve-device]').forEach(b=>b.onclick=async()=>{try{const ok=await rpc('etl_approve_device',{p_actor_device_id:deviceId,p_target_device_id:b.dataset.approveDevice});await refreshDevices();alert(ok?'ডিভাইস অনুমোদিত হয়েছে। নতুন ডিভাইসে “আবার যাচাই করুন” চাপুন।':'ডিভাইস অনুমোদন করা যায়নি; তালিকা রিফ্রেশ করুন।')}catch(e){alert(e.message)}});
      el.querySelectorAll('[data-revoke-device]').forEach(b=>b.onclick=async()=>{if(!confirm('এই ডিভাইসের Cloud প্রবেশাধিকার বাতিল করবেন?'))return;try{await rpc('etl_revoke_device',{p_actor_device_id:deviceId,p_target_device_id:b.dataset.revokeDevice});await refreshDevices()}catch(e){alert(e.message)}});
    }catch(e){el.textContent='ডিভাইস তালিকা পাওয়া যায়নি: '+e.message}
  }
  function escapeHtml(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
  async function resolveFirstSync(){
    const cloud=await rpc('etl_get_cloud_data',{p_device_id:deviceId});
    const local=localData();
    if(cloud){
      cloudVersion=cloud.updated_at;
      if(!hasLocal()){
        applyCloud(cloud);
      }else if(!same(local,cloud.payload)){
        // Preserve the local ledger before asking which copy should be used.
        backupLocal();
        const takeCloud=confirm('এই অ্যাকাউন্টে আগে থেকে Cloud হিসাব আছে এবং এই ডিভাইসেও আলাদা হিসাব আছে।\n\nOK = Cloud হিসাব এই ডিভাইসে আনুন (লোকাল হিসাবের Backup ডাউনলোড হবে)।\nCancel = লোকাল হিসাব রাখুন; Cloud-এ কিছু পাঠানো হবে না।\n\nদুই হিসাব একসঙ্গে মিশবে না।');
        if(takeCloud){applyCloud(cloud)}
        else{sessionReady=false;status('লোকাল হিসাব রাখা হয়েছে — Cloud Sync স্থগিত। Settings থেকে পরে Cloud-এ পাঠাতে পারবেন।')}
      }else{
        lastSyncedSnapshot=snapshot(local);sessionReady=true;status('Cloud সিঙ্ক সম্পন্ন');
      }
    }else{
      // First cloud save for this account. This only creates a new cloud record.
      cloudVersion=await rpc('etl_save_cloud_data',{p_device_id:deviceId,p_payload:local||{},p_expected_updated_at:null});
      lastSyncedSnapshot=snapshot(local);sessionReady=true;status('প্রথম Cloud Backup সম্পন্ন');
    }
  }
  async function finishLogin(){
    if(loginInProgress)return;
    loginInProgress=true;
    try{
    const {data:{user}}=await client.auth.getUser();
    if(!user){gate(true);return}
    let state;
    try{state=await rpc('etl_register_device',{p_device_id:deviceId,p_device_name:deviceName(),p_platform:platform()})}
    catch(e){authMessage('ডিভাইস নিবন্ধন হয়নি: '+e.message);gate(true);return}
    if(state==='pending'){approved=false;sessionReady=false;showArea('etlPendingArea');authMessage('এই ডিভাইসটি আপনার অন্য অনুমোদিত ডিভাইস থেকে অনুমোদন করুন।');gate(true);return}
    if(state==='revoked'){approved=false;sessionReady=false;showArea('etlDeniedArea');authMessage('এই ডিভাইসের প্রবেশাধিকার বাতিল করা হয়েছে।');gate(true);return}
    approved=true;
    try{
      await resolveFirstSync();
      gate(false);
      if($('cloudDeviceName'))$('cloudDeviceName').value=deviceName();
      await refreshDevices();
      await updateIdentityStatus();
    }catch(e){status('Cloud সংযোগ সমস্যা: '+e.message);sessionReady=false;gate(false);}
    }finally{loginInProgress=false}
  }
  async function signInGoogle(){
    if(!client)return authMessage('Cloud Login চালু হয়নি। ইন্টারনেট সংযোগ ও Supabase configuration পরীক্ষা করুন।');
    if(location.protocol==='file:')return authMessage('Google Login চালাতে অ্যাপটি HTTPS ওয়েব ঠিকানায় প্রকাশ করতে হবে; সরাসরি HTML ফাইল থেকে OAuth কাজ করবে না।');
    const btn=$('etlGoogleLogin');if(btn){btn.disabled=true;btn.textContent='Google-এ সংযোগ হচ্ছে…'}
    authMessage('Google Login পেজে পাঠানো হচ্ছে। পেজ না বদলালে Supabase-এর Google Provider ও Redirect URL পরীক্ষা করতে হবে।');
    try{
      const redirectTo=location.origin+location.pathname;
      const {error}=await client.auth.signInWithOAuth({provider:'google',options:{redirectTo,queryParams:{prompt:'select_account'}}});
      if(error)authMessage('Google Login শুরু করা যায়নি: '+(error.message||String(error)));
    }catch(e){authMessage('Google Login শুরু করা যায়নি: '+(e?.message||String(e)));console.error('Eye Touch Link Google OAuth:',e)}
    finally{if(btn){btn.disabled=false;btn.textContent='Google দিয়ে প্রবেশ'}}
  }
  async function sendEmail(){
    if(!client)return authMessage('Cloud Login চালু হয়নি। ইন্টারনেট সংযোগ ও Supabase configuration পরীক্ষা করুন।');
    const field=$('etlLoginIdentity'),email=(field?.value||'').trim();
    if(!/^\S+@\S+\.\S+$/.test(email)){authMessage('সঠিক Gmail / ইমেইল লিখুন।');field?.focus();return}
    const btn=$('etlSendEmail');if(btn){btn.disabled=true;btn.textContent='পাঠানো হচ্ছে…'}
    authMessage('Supabase-এ Login Link পাঠানোর অনুরোধ যাচ্ছে…');
    try{
      // This account already exists (Google sign-in); do not create a second Auth user.
      const {error}=await client.auth.signInWithOtp({email,options:{shouldCreateUser:false,emailRedirectTo:location.origin+location.pathname}});
      if(error)throw error;
      authMessage('Supabase অনুরোধ গ্রহণ করেছে। Gmail Inbox, Spam ও Promotions দেখুন। ১–২ মিনিটেও ইমেইল না এলে Supabase SMTP / Email provider সেটিংস পরীক্ষা করতে হবে।');
    }catch(e){
      const message=e?.message||String(e);
      authMessage('Login Link পাঠানো যায়নি: '+message+' (Supabase Authentication > Email / SMTP সেটিংস পরীক্ষা প্রয়োজন হতে পারে।)');
      console.error('Eye Touch Link email OTP:',e);
    }finally{if(btn){btn.disabled=false;btn.textContent='Gmail-এ Login Link'}}
  }
  async function sendPhone(){
    const phone=$('etlLoginIdentity').value.trim();
    if(!/^\+[1-9]\d{7,14}$/.test(phone))return authMessage('ফোন নম্বর আন্তর্জাতিক ফরম্যাটে লিখুন, যেমন +8801XXXXXXXXX');
    // Do not silently create a second Supabase user when the phone has not been linked.
    const {error}=await client.auth.signInWithOtp({phone,options:{shouldCreateUser:false}});
    if(error){authMessage('এই ফোন নম্বরটি আগে আপনার Google/Gmail অ্যাকাউন্টে যুক্ত ও যাচাই করতে হবে। নতুন আলাদা অ্যাকাউন্ট তৈরি করা হয়নি। বিস্তারিত: '+error.message);return}
    $('etlOtpArea').style.display='block';$('etlOtp').dataset.kind='sms';$('etlOtp').dataset.identity=phone;authMessage('ফোনে OTP পাঠানো হয়েছে। কোড লিখে যাচাই করুন।')
  }
  async function verifyOtp(){const token=$('etlOtp').value.trim(),kind=$('etlOtp').dataset.kind,identity=$('etlOtp').dataset.identity;if(!token||!identity)return authMessage('OTP কোড লিখুন।');const args=kind==='sms'?{phone:identity,token,type:'sms'}:{email:identity,token,type:'email'};const {error}=await client.auth.verifyOtp(args);if(error)return authMessage('OTP যাচাই হয়নি: '+error.message);await finishLogin()}
  async function reloadCloud(){if(!approved)return;try{const c=await rpc('etl_get_cloud_data',{p_device_id:deviceId});if(!c)return alert('Cloud-এ এখনো কোনো হিসাব নেই।');if(!confirm('Cloud-এর হিসাব এই ডিভাইসে বসাবেন? বর্তমান লোকাল হিসাবের JSON Backup আগে ডাউনলোড হবে।'))return;backupLocal();window.etlSetDb(c.payload);cloudVersion=c.updated_at;lastSyncedSnapshot=snapshot(c.payload);sessionReady=true;status('Cloud থেকে হিসাব আনা হয়েছে')}catch(e){alert('Cloud হিসাব আনা যায়নি: '+e.message)}}
  async function pushLocalToCloud(){if(!approved)return;try{const c=await rpc('etl_get_cloud_data',{p_device_id:deviceId});if(c){backupCloud(c);if(!confirm('Cloud-এ আগে থেকে হিসাব আছে। সেটির Backup ডাউনলোড করা হয়েছে। এই ডিভাইসের লোকাল হিসাব দিয়ে Cloud হিসাব প্রতিস্থাপন করবেন?'))return;cloudVersion=await rpc('etl_save_cloud_data',{p_device_id:deviceId,p_payload:localData(),p_expected_updated_at:c.updated_at})}else{if(!confirm('Cloud-এ হিসাব নেই। এই ডিভাইসের লোকাল হিসাব প্রথমবার Cloud-এ সংরক্ষণ করবেন?'))return;cloudVersion=await rpc('etl_save_cloud_data',{p_device_id:deviceId,p_payload:localData(),p_expected_updated_at:null})}lastSyncedSnapshot=snapshot(localData());sessionReady=true;status('লোকাল হিসাব Cloud-এ সংরক্ষিত হয়েছে')}catch(e){status('Cloud-এ পাঠানো যায়নি: '+e.message);alert('Cloud-এ পাঠানো যায়নি: '+e.message)}}
  async function checkRemote(){if(!client||!approved||!sessionReady||!navigator.onLine||pollBusy)return;pollBusy=true;try{const remote=await rpc('etl_get_cloud_data',{p_device_id:deviceId});if(!remote||remote.updated_at===cloudVersion)return;const local=localData();if(same(local,lastSyncedSnapshot)){applyCloud(remote)}else{status('অন্য ডিভাইসে নতুন হিসাব আছে — Settings থেকে Cloud হিসাব আনুন; আপনার লোকাল পরিবর্তন মুছে ফেলা হয়নি।')}}catch(e){if(navigator.onLine)console.warn('Cloud refresh:',e.message)}finally{pollBusy=false}}
  function queueSave(data){if(!configured||!client||!approved||!sessionReady)return;clearTimeout(saveTimer);saveTimer=setTimeout(async()=>{if(cloudBusy){queueSave(localData());return}cloudBusy=true;try{cloudVersion=await rpc('etl_save_cloud_data',{p_device_id:deviceId,p_payload:data,p_expected_updated_at:cloudVersion});lastSyncedSnapshot=snapshot(data);status('Cloud সিঙ্ক সম্পন্ন')}catch(e){status(e.message.includes('CLOUD_CONFLICT')?'অন্য ডিভাইসে পরিবর্তন হয়েছে — Settings থেকে Cloud হিসাব আনুন':'অফলাইন / Sync অপেক্ষমাণ');console.warn('Eye Touch Link cloud save:',e.message)}finally{cloudBusy=false}},900)}
  let pendingPhoneLinkUserId=null;
  async function updateIdentityStatus(){
    const el=$('cloudIdentityStatus');if(!el||!client)return;
    try{
      const {data:{user},error}=await client.auth.getUser();if(error)throw error;
      if(!user){el.textContent='প্রথমে Google দিয়ে প্রবেশ করুন।';return}
      const email=user.email||'ইমেইল পাওয়া যায়নি';
      const phone=user.phone||'এখনো যুক্ত হয়নি';
      const verified=user.phone_confirmed_at?'যাচাইকৃত':'যাচাই বাকি';
      el.textContent=`এই অ্যাকাউন্টের Gmail: ${email} • ফোন: ${phone} (${user.phone?verified:'ফোন যুক্ত হয়নি'})`;
    }catch(e){el.textContent='অ্যাকাউন্টের পরিচয় দেখা যায়নি: '+e.message}
  }
  async function linkPhone(){
    const phone=$('cloudLinkPhone').value.trim();
    if(!/^\+[1-9]\d{7,14}$/.test(phone))return alert('আন্তর্জাতিক ফরম্যাটে নম্বর লিখুন, যেমন +8801XXXXXXXXX');
    const {data:{user},error:getError}=await client.auth.getUser();
    if(getError||!user)return alert('আগে Google দিয়ে এই অ্যাকাউন্টে প্রবেশ করুন।');
    if(user.phone===phone&&user.phone_confirmed_at){await updateIdentityStatus();return alert('এই ফোন নম্বরটি ইতিমধ্যে এই অ্যাকাউন্টে যাচাই করা আছে।')}
    const {error}=await client.auth.updateUser({phone});
    if(error)return alert('ফোন যুক্ত করার অনুরোধ ব্যর্থ: '+error.message);
    pendingPhoneLinkUserId=user.id;
    $('cloudLinkOtp').dataset.kind='phone_change';$('cloudLinkOtp').dataset.identity=phone;
    alert('ফোনে OTP পাঠানো হয়েছে। কোডটি লিখে “OTP যাচাই করে যুক্ত করুন” চাপুন।');
  }
  async function verifyLinked(){
    const token=$('cloudLinkOtp').value.trim(),kind=$('cloudLinkOtp').dataset.kind,identity=$('cloudLinkOtp').dataset.identity;
    if(!token||kind!=='phone_change'||!identity||!pendingPhoneLinkUserId)return alert('আগে Google দিয়ে প্রবেশ করে ফোন যুক্ত করার OTP নিন।');
    const {data,error}=await client.auth.verifyOtp({phone:identity,token,type:'phone_change'});
    if(error)return alert('যাচাই হয়নি: '+error.message);
    const linkedUserId=data.user?.id|| (await client.auth.getUser()).data.user?.id;
    if(linkedUserId!==pendingPhoneLinkUserId){alert('নিরাপত্তার কারণে নিশ্চিত করা যাচ্ছে না যে একই অ্যাকাউন্টে ফোন যুক্ত হয়েছে। কোনো হিসাব পরিবর্তন করা হয়নি।');return}
    pendingPhoneLinkUserId=null;$('cloudLinkOtp').value='';$('cloudLinkOtp').dataset.kind='';$('cloudLinkOtp').dataset.identity='';
    await updateIdentityStatus();
    alert('ফোন নম্বর একই Google/Gmail অ্যাকাউন্টে যাচাই করে যুক্ত হয়েছে। এখন এই ফোন দিয়ে OTP Login করলে একই হিসাব খুলবে।');
  }
  async function init(){
    if(!configured||!window.supabase?.createClient){status('Cloud key সেটআপ বাকি — লোকাল হিসাব চালু');const el=$('cloudDeviceList');if(el)el.textContent='Supabase key / library সেটআপের পর Cloud Sync চালু হবে।';markAuthReady();return}
    client=window.supabase.createClient(cfg.url,cfg.anonKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
    $('etlGoogleLogin').onclick=signInGoogle;$('etlSendEmail').onclick=sendEmail;$('etlSendPhone').onclick=sendPhone;$('etlVerifyOtp').onclick=verifyOtp;$('etlCheckApproval').onclick=finishLogin;$('etlTryAgain').onclick=finishLogin;
    $('cloudRefreshDevices').onclick=refreshDevices;$('cloudReloadData').onclick=reloadCloud;$('cloudPushData').onclick=pushLocalToCloud;$('cloudSignOut').onclick=async()=>{if(confirm('এই ডিভাইস থেকে লগআউট করবেন?')){await client.auth.signOut();location.reload()}};
    $('cloudSaveDeviceName').onclick=async()=>{const n=$('cloudDeviceName').value.trim();if(!n)return alert('ডিভাইসের নাম লিখুন।');localStorage.setItem(NAME_KEY,n);if(approved){try{await rpc('etl_register_device',{p_device_id:deviceId,p_device_name:n,p_platform:platform()});await refreshDevices();alert('ডিভাইসের নাম সংরক্ষিত হয়েছে।')}catch(e){alert(e.message)}}};
    $('cloudLinkPhoneBtn').onclick=linkPhone;$('cloudVerifyLinkBtn').onclick=verifyLinked;
    await updateIdentityStatus();
    const {data:{session}}=await client.auth.getSession();
    if(session){gate(true);authMessage('আপনার ডিভাইস যাচাই করা হচ্ছে...');await finishLogin()}else{showArea('etlLoginFields');gate(true);status('Login প্রয়োজন')}
    markAuthReady();
    client.auth.onAuthStateChange((event,session)=>{if(event==='SIGNED_IN'&&session){setTimeout(()=>finishLogin().catch(e=>{authMessage('Login সমস্যা: '+e.message)}),0)}if(event==='SIGNED_OUT'){approved=false;sessionReady=false;gate(true)}});
    setInterval(checkRemote,15000);
    const recheck=async()=>{if(!approved||!navigator.onLine)return;try{const st=await rpc('etl_register_device',{p_device_id:deviceId,p_device_name:deviceName(),p_platform:platform()});if(st!=='approved'){approved=false;sessionReady=false;showArea(st==='revoked'?'etlDeniedArea':'etlPendingArea');authMessage('এই ডিভাইসের অনুমোদন আর সক্রিয় নেই।');gate(true)}}catch(e){console.warn('Device approval check:',e.message)}};
    window.addEventListener('online',()=>{recheck();checkRemote();if(approved&&sessionReady)queueSave(localData())});document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){recheck();checkRemote()}});
  }
  window.etlCloud={init,queueSave,refreshDevices,deviceId};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
