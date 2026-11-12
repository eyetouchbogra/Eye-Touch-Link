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
  const FIRST_SYNC_KEY='etl_first_sync_choice_v1';
  const deviceId=(()=>{let x=localStorage.getItem(DEVICE_KEY);if(!x){x=(crypto.randomUUID?crypto.randomUUID():('etl-'+Date.now()+'-'+Math.random().toString(36).slice(2)));localStorage.setItem(DEVICE_KEY,x)}return x})();
  const platform=()=>/Android/i.test(navigator.userAgent)?'Android':/iPhone|iPad/i.test(navigator.userAgent)?'iOS':/Windows/i.test(navigator.userAgent)?'Windows':'Web';
  const deviceName=()=>localStorage.getItem(NAME_KEY)||(`${platform()} device`);
  let client=null,approved=false,saveTimer=null,cloudBusy=false,sessionReady=false,cloudVersion=null,lastSyncedSnapshot=null,pollBusy=false,loginInProgress=false;
  let currentUserId=null,loginResolvedUserId=null;
  const firstSyncDecisionKey=()=>currentUserId?`${FIRST_SYNC_KEY}:${currentUserId}:${deviceId}`:null;
  const saveFirstSyncDecision=value=>{const key=firstSyncDecisionKey();if(key)localStorage.setItem(key,value)};
  const status=(msg)=>{const n=$('cloudStatusText');if(n)n.textContent=msg;const h=$('localSaveLabel');if(h)h.textContent=msg.includes('Sync')||msg.includes('সিঙ্ক')?'☁ Cloud Sync':msg.includes('Offline')||msg.includes('অফলাইন')?'● Offline':'☁ '+msg.slice(0,24)};
  const gate=(show)=>{const g=$('etlAuthGate');if(g)g.style.display=show?'flex':'none';const layout=document.querySelector('.layout'),top=document.querySelector('.top');if(layout)layout.style.visibility=show?'hidden':'visible';if(top)top.style.visibility=show?'hidden':'visible'};
  const authMessage=(m)=>{if($('etlAuthMessage'))$('etlAuthMessage').textContent=m};
  function updateIdentityStatus(user){
    const el=$('cloudIdentityStatus');
    if(!el)return;
    if(!user){el.textContent='এই ডিভাইসে Cloud Login করা হয়নি।';return;}
    const providers=new Set([...(user.identities||[]).map(x=>x.provider),user.app_metadata?.provider].filter(Boolean));
    const email=user.email?('Gmail: '+user.email):'Gmail পাওয়া যায়নি';
    const phone=user.phone?('ফোন যাচাই করা আছে: '+user.phone):'ফোন এখনো যুক্ত/যাচাই করা হয়নি';
    const google=providers.has('google')?'Google Login সংযুক্ত':'এই Login-এ Google পরিচয় পাওয়া যায়নি';
    el.textContent=email+' · '+phone+' · '+google;
  }
  const showArea=(which)=>{['etlLoginFields','etlPendingArea','etlDeniedArea'].forEach(id=>{if($(id))$(id).style.display=id===which?'block':'none'})};
  const rpc=async(name,args)=>{const {data,error}=await client.rpc(name,args);if(error)throw error;return data};
  const localData=()=>window.etlGetDb?.()||null;
  const hasLocal=()=>{const d=localData();return !!(d&&(d.tx?.length||d.debts?.length||d.ledger?.length||d.people?.length))};
  const snapshot=d=>JSON.stringify(d??null);
  const same=(a,b)=>snapshot(a)===snapshot(b);
  function downloadJson(filename,data){const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;a.style.display='none';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),3000)}
  function backupLocal(){const d=localData();if(d)downloadJson('Eye-Touch-Link-local-backup-'+new Date().toISOString().slice(0,10)+'.json',d)}
  function backupCloud(d){if(d?.payload)downloadJson('Eye-Touch-Link-cloud-backup-'+new Date().toISOString().slice(0,10)+'.json',d.payload)}
  function applyCloud(d){window.etlSetDb(d.payload);cloudVersion=d.updated_at;lastSyncedSnapshot=snapshot(d.payload);status('অন্য ডিভাইসের হিসাব Sync হয়েছে')}
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

    if(cloud){
      cloudVersion=cloud.updated_at;

      if(!hasLocal()){
        applyCloud(cloud);
        saveFirstSyncDecision('resolved');

      }else if(!same(local,cloud.payload)){
        // Remember the user's choice for this account on this device.
        // Cancel never downloads a backup and never replaces local data.
        if(previousChoice==='keep_local'){
          sessionReady=false;
          status('আপনার আগের সিদ্ধান্ত অনুযায়ী লোকাল হিসাব রাখা হয়েছে। Cloud Sync স্থগিত; Settings থেকে নিজে Sync/Restore করুন।');
          return;
        }
        if(previousChoice==='resolved'){
          sessionReady=false;
          status('লোকাল ও Cloud হিসাব আলাদা। আপনার লোকাল হিসাব নিরাপদে রাখা হয়েছে; Settings থেকে নিজে Cloud Sync/Restore নির্বাচন করুন।');
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
        lastSyncedSnapshot=snapshot(local);
        sessionReady=true;
        saveFirstSyncDecision('resolved');
        status('Cloud সিঙ্ক সম্পন্ন');
      }

    }else{
      // First cloud save for this account.
      cloudVersion=await rpc('etl_save_cloud_data',{p_device_id:deviceId,p_payload:local||{},p_expected_updated_at:null});
      lastSyncedSnapshot=snapshot(local);
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
    updateIdentityStatus(user);
    if(!user){currentUserId=null;gate(true);return}
    if(loginResolvedUserId===user.id)return;
    currentUserId=user.id;
    let state;
    try{state=await rpc('etl_register_device',{p_device_id:deviceId,p_device_name:deviceName(),p_platform:platform()})}
    catch(e){authMessage('ডিভাইস নিবন্ধন হয়নি: '+e.message);gate(true);return}
    if(state==='pending'){approved=false;sessionReady=false;showArea('etlPendingArea');authMessage('এই ডিভাইসটি আপনার অন্য অনুমোদিত ডিভাইস থেকে অনুমোদন করুন।');gate(true);return}
    if(state==='revoked'){approved=false;sessionReady=false;showArea('etlDeniedArea');authMessage('এই ডিভাইসের প্রবেশাধিকার বাতিল করা হয়েছে।');gate(true);return}
    approved=true;
    try{
      await resolveFirstSync();
      loginResolvedUserId=user.id;
      gate(false);
      if($('cloudDeviceName'))$('cloudDeviceName').value=deviceName();
      await refreshDevices();
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
      const {error}=await client.auth.signInWithOAuth({
        provider:'google',
        options:{
          redirectTo:location.origin+location.pathname,
          queryParams:{prompt:'select_account'}
        }
      });
      if(error)throw error;
    }catch(e){
      authMessage('Google Login ব্যর্থ: '+(e.message||e));
      btn.disabled=false;btn.textContent=old;
    }
  }
  async function signInWithPassword(){
    const email=$('etlLoginIdentity').value.trim();
    const password=$('etlLoginPassword').value;
    if(!/^\S+@\S+\.\S+$/.test(email))return authMessage('PC-তে ব্যবহৃত একই Gmail লিখুন।');
    if(!password)return authMessage('Eye Touch Link Password লিখুন।');
    const btn=$('etlPasswordLogin');
    const old=btn?.textContent;
    if(btn){btn.disabled=true;btn.textContent='প্রবেশ যাচাই হচ্ছে…';}
    try{
      const {error}=await client.auth.signInWithPassword({email,password});
      if(error)throw error;
      authMessage('Password সঠিক। এই ডিভাইসের অনুমোদন যাচাই হচ্ছে…');
      await finishLogin();
    }catch(e){
      authMessage('Gmail + Password দিয়ে প্রবেশ হয়নি: '+(e.message||e));
    }finally{
      if(btn){btn.disabled=false;btn.textContent=old||'Gmail + Password দিয়ে প্রবেশ';}
    }
  }
  async function setAccountPassword(){
    if(!client)return alert('Cloud সংযোগ প্রস্তুত হয়নি।');
    const p1=$('cloudNewPassword')?.value||'';
    const p2=$('cloudConfirmPassword')?.value||'';
    if(p1.length<8)return alert('কমপক্ষে ৮ অক্ষরের Password দিন।');
    if(p1!==p2)return alert('দুটি Password এক নয়।');
    try{
      const {data:{user},error:userError}=await client.auth.getUser();
      if(userError)throw userError;
      if(!user||!user.email)return alert('এই PC-তে সক্রিয় Cloud Login পাওয়া যায়নি। আগে PC-তে Google দিয়ে প্রবেশ করুন।');
      const providers=new Set([...(user.identities||[]).map(x=>x.provider),user.app_metadata?.provider].filter(Boolean));
      if(!providers.has('google'))return alert('এই PC-র সক্রিয় Cloud অ্যাকাউন্টে Google পরিচয় পাওয়া যায়নি। সঠিক Google-লগইন করা অ্যাকাউন্টে করুন।');
      const {error}=await client.auth.updateUser({password:p1});
      if(error)throw error;
      $('cloudNewPassword').value='';$('cloudConfirmPassword').value='';
      alert('এই একই Eye Touch Link Cloud অ্যাকাউন্টে Password যুক্ত হয়েছে। এখন ফোনে Google Login না করে একই Gmail ও এই নতুন Password দিয়ে প্রবেশ করুন। এটি Google/Gmail Password নয়।');
    }catch(e){
      alert('Password যুক্ত করা যায়নি: '+(e.message||e));
    }
  }
  async function sendEmail(){
    const email=$('etlLoginIdentity').value.trim();
    if(!/^\S+@\S+\.\S+$/.test(email))return authMessage('সঠিক Gmail / ইমেইল লিখুন।');
    const btn=$('etlSendEmail');btn.disabled=true;const old=btn.textContent;btn.textContent='লিংক পাঠানো হচ্ছে…';
    try{
      const {error}=await client.auth.signInWithOtp({email,options:{emailRedirectTo:location.origin+location.pathname,shouldCreateUser:false}});
      if(error)throw error;
      authMessage('আপনার Gmail-এ Login Link পাঠানো হয়েছে। একই ফোন/কম্পিউটারের এই ব্রাউজারে লিংকটি খুলুন।');
    }catch(e){authMessage('ইমেইল পাঠানো যায়নি: '+(e.message||e));}
    finally{btn.disabled=false;btn.textContent=old;}
  }
  async function sendPhone(){
    const phone=$('etlLoginIdentity').value.trim();
    if(!/^\+[1-9]\d{7,14}$/.test(phone))return authMessage('ফোন নম্বর আন্তর্জাতিক ফরম্যাটে লিখুন, যেমন +8801XXXXXXXXX');
    const btn=$('etlSendPhone');btn.disabled=true;const old=btn.textContent;btn.textContent='OTP পাঠানো হচ্ছে…';
    try{
      const {error}=await client.auth.signInWithOtp({phone,options:{shouldCreateUser:false}});
      if(error)throw error;
      $('etlOtpArea').style.display='block';$('etlOtp').dataset.kind='sms';$('etlOtp').dataset.identity=phone;
      authMessage('ফোনে OTP পাঠানো হয়েছে। কোড লিখে যাচাই করুন।');
    }catch(e){authMessage('OTP পাঠানো যায়নি: '+(e.message||e));}
    finally{btn.disabled=false;btn.textContent=old;}
  }
  async function verifyOtp(){const token=$('etlOtp').value.trim(),kind=$('etlOtp').dataset.kind,identity=$('etlOtp').dataset.identity;if(!token||!identity)return authMessage('OTP কোড লিখুন।');const args=kind==='sms'?{phone:identity,token,type:'sms'}:{email:identity,token,type:'email'};const {error}=await client.auth.verifyOtp(args);if(error)return authMessage('OTP যাচাই হয়নি: '+error.message);await finishLogin()}
  async function reloadCloud(){if(!approved)return;try{const c=await rpc('etl_get_cloud_data',{p_device_id:deviceId});if(!c)return alert('Cloud-এ এখনো কোনো হিসাব নেই।');if(!confirm('Cloud-এর হিসাব এই ডিভাইসে বসাবেন? OK দিলে বর্তমান লোকাল হিসাবের JSON Backup ডাউনলোড হবে। Cancel করলে কোনো পরিবর্তন বা Backup হবে না।'))return;backupLocal();window.etlSetDb(c.payload);cloudVersion=c.updated_at;lastSyncedSnapshot=snapshot(c.payload);sessionReady=true;saveFirstSyncDecision('resolved');status('Cloud থেকে হিসাব আনা হয়েছে')}catch(e){alert('Cloud হিসাব আনা যায়নি: '+e.message)}}
  async function pushLocalToCloud(){if(!approved)return;try{const c=await rpc('etl_get_cloud_data',{p_device_id:deviceId});if(c){if(!confirm('Cloud-এ আগে থেকে হিসাব আছে। OK দিলে Cloud হিসাবের Backup ডাউনলোড হবে এবং এরপর এই ডিভাইসের লোকাল হিসাব দিয়ে Cloud প্রতিস্থাপন হবে। Cancel করলে কোনো Backup বা পরিবর্তন হবে না।'))return;backupCloud(c);cloudVersion=await rpc('etl_save_cloud_data',{p_device_id:deviceId,p_payload:localData(),p_expected_updated_at:c.updated_at})}else{if(!confirm('Cloud-এ হিসাব নেই। এই ডিভাইসের লোকাল হিসাব প্রথমবার Cloud-এ সংরক্ষণ করবেন?'))return;cloudVersion=await rpc('etl_save_cloud_data',{p_device_id:deviceId,p_payload:localData(),p_expected_updated_at:null})}lastSyncedSnapshot=snapshot(localData());sessionReady=true;saveFirstSyncDecision('resolved');status('লোকাল হিসাব Cloud-এ সংরক্ষিত হয়েছে')}catch(e){status('Cloud-এ পাঠানো যায়নি: '+e.message);alert('Cloud-এ পাঠানো যায়নি: '+e.message)}}
  async function checkRemote(){if(!client||!approved||!sessionReady||!navigator.onLine||pollBusy)return;pollBusy=true;try{const remote=await rpc('etl_get_cloud_data',{p_device_id:deviceId});if(!remote||remote.updated_at===cloudVersion)return;const local=localData();if(same(local,lastSyncedSnapshot)){applyCloud(remote)}else{status('অন্য ডিভাইসে নতুন হিসাব আছে — Settings থেকে Cloud হিসাব আনুন; আপনার লোকাল পরিবর্তন মুছে ফেলা হয়নি।')}}catch(e){if(navigator.onLine)console.warn('Cloud refresh:',e.message)}finally{pollBusy=false}}
  function queueSave(data){if(!configured||!client||!approved||!sessionReady)return;clearTimeout(saveTimer);saveTimer=setTimeout(async()=>{if(cloudBusy){queueSave(localData());return}cloudBusy=true;try{cloudVersion=await rpc('etl_save_cloud_data',{p_device_id:deviceId,p_payload:data,p_expected_updated_at:cloudVersion});lastSyncedSnapshot=snapshot(data);status('Cloud সিঙ্ক সম্পন্ন')}catch(e){status(e.message.includes('CLOUD_CONFLICT')?'অন্য ডিভাইসে পরিবর্তন হয়েছে — Settings থেকে Cloud হিসাব আনুন':'অফলাইন / Sync অপেক্ষমাণ');console.warn('Eye Touch Link cloud save:',e.message)}finally{cloudBusy=false}},900)}
  async function linkEmail(){const email=$('cloudLinkEmail').value.trim();if(!/^\S+@\S+\.\S+$/.test(email))return alert('সঠিক Gmail লিখুন।');const {error}=await client.auth.updateUser({email});alert(error?'Gmail যুক্ত করার অনুরোধ ব্যর্থ: '+error.message:'Gmail-এ নিশ্চিতকরণ লিংক পাঠানো হয়েছে। লিংকে চাপ দিয়ে নিশ্চিত করুন।')}
  async function linkPhone(){const phone=$('cloudLinkPhone').value.trim();if(!/^\+[1-9]\d{7,14}$/.test(phone))return alert('আন্তর্জাতিক ফরম্যাটে নম্বর লিখুন, যেমন +8801XXXXXXXXX');const {error}=await client.auth.updateUser({phone});if(error)return alert('ফোন যুক্ত করার অনুরোধ ব্যর্থ: '+error.message);$('cloudLinkOtp').dataset.kind='phone_change';$('cloudLinkOtp').dataset.identity=phone;alert('ফোনে OTP পাঠানো হয়েছে। কোডটি লিখে OTP যাচাই চাপুন।')}
  async function verifyLinked(){const token=$('cloudLinkOtp').value.trim(),kind=$('cloudLinkOtp').dataset.kind,identity=$('cloudLinkOtp').dataset.identity;if(!token||!kind||!identity)return alert('আগে Gmail বা ফোন যুক্ত করার অনুরোধ পাঠান।');const args=kind==='phone_change'?{phone:identity,token,type:'phone_change'}:{email:identity,token,type:'email_change'};const {error}=await client.auth.verifyOtp(args);if(error)return alert('যাচাই হয়নি: '+error.message);const {data:{user}}=await client.auth.getUser();updateIdentityStatus(user);alert('বিকল্প পরিচয় যুক্ত হয়েছে। এখন Gmail বা ফোন—দুটির যেকোনোটি দিয়ে একই Cloud অ্যাকাউন্টে প্রবেশ করা যাবে।')}
  function setLoginButtonsEnabled(enabled){['etlGoogleLogin','etlSendEmail','etlSendPhone','etlVerifyOtp','etlPasswordLogin'].forEach(id=>{const b=$(id);if(b)b.disabled=!enabled})}
  function loadSupabaseFallback(src){return new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=src;script.async=true;script.onload=()=>resolve();script.onerror=()=>reject(new Error('লাইব্রেরি লোড হয়নি: '+src));document.head.appendChild(script);setTimeout(()=>reject(new Error('Supabase লাইব্রেরি লোড হতে সময় শেষ হয়েছে')),12000)})}
  async function init(){
    // নিরাপত্তা: Cloud/Auth প্রস্তুত না থাকলে লোকাল ড্যাশবোর্ড কখনো Login ছাড়াই দেখাবেন না।
    gate(true);showArea('etlLoginFields');authMessage('নিরাপদ Cloud Login প্রস্তুত হচ্ছে…');
    if(!configured){setLoginButtonsEnabled(false);authMessage('Cloud configuration পাওয়া যায়নি। supabase-config.js ও public key পরীক্ষা প্রয়োজন।');status('Cloud configuration অসম্পূর্ণ — Login বন্ধ');const el=$('cloudDeviceList');if(el)el.textContent='Supabase configuration সম্পূর্ণ না হওয়া পর্যন্ত Cloud Login চালু হবে না।';return}
    if(!window.supabase?.createClient){
      try{await loadSupabaseFallback('https://unpkg.com/@supabase/supabase-js@2');}catch(firstError){
        try{await loadSupabaseFallback('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2');}catch(secondError){
          setLoginButtonsEnabled(false);authMessage('Supabase Login লাইব্রেরি লোড হয়নি। ইন্টারনেট সংযোগ পরীক্ষা করে পেজ Refresh করুন।');status('Cloud Login লাইব্রেরি পাওয়া যায়নি');console.error(firstError,secondError);return;
        }
      }
    }
    if(!window.supabase?.createClient){setLoginButtonsEnabled(false);authMessage('Supabase লাইব্রেরি পাওয়া যায়নি। পেজ Refresh করুন।');status('Cloud Login লাইব্রেরি পাওয়া যায়নি');return}
    setLoginButtonsEnabled(true);
    client=window.supabase.createClient(cfg.url,cfg.anonKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
    $('etlGoogleLogin').onclick=signInGoogle;$('etlPasswordLogin').onclick=signInWithPassword;$('cloudSetPassword').onclick=setAccountPassword;$('etlSendEmail').onclick=sendEmail;$('etlSendPhone').onclick=sendPhone;$('etlVerifyOtp').onclick=verifyOtp;$('etlCheckApproval').onclick=finishLogin;$('etlTryAgain').onclick=finishLogin;
    $('cloudRefreshDevices').onclick=refreshDevices;$('cloudReloadData').onclick=reloadCloud;$('cloudPushData').onclick=pushLocalToCloud;$('cloudSignOut').onclick=async()=>{if(confirm('এই ডিভাইস থেকে লগআউট করবেন?')){await client.auth.signOut();location.reload()}};
    $('cloudSaveDeviceName').onclick=async()=>{const n=$('cloudDeviceName').value.trim();if(!n)return alert('ডিভাইসের নাম লিখুন।');localStorage.setItem(NAME_KEY,n);if(approved){try{await rpc('etl_register_device',{p_device_id:deviceId,p_device_name:n,p_platform:platform()});await refreshDevices();alert('ডিভাইসের নাম সংরক্ষিত হয়েছে।')}catch(e){alert(e.message)}}};
    // Email-link fields are not present in this app's current Settings HTML.
    // Guard them so a missing optional control cannot abort Cloud/Auth initialization.
    if($('cloudLinkEmailBtn'))$('cloudLinkEmailBtn').onclick=linkEmail;
    if($('cloudLinkPhoneBtn'))$('cloudLinkPhoneBtn').onclick=linkPhone;
    if($('cloudVerifyLinkBtn'))$('cloudVerifyLinkBtn').onclick=verifyLinked;
    const {data:{session}}=await client.auth.getSession();
    if(session){gate(true);authMessage('আপনার ডিভাইস যাচাই করা হচ্ছে...');await finishLogin()}else{showArea('etlLoginFields');gate(true);status('Login প্রয়োজন')}
    client.auth.onAuthStateChange((event,session)=>{if(event==='SIGNED_IN'&&session){setTimeout(()=>finishLogin().catch(e=>{authMessage('Login সমস্যা: '+e.message)}),0)}if(event==='SIGNED_OUT'){approved=false;sessionReady=false;currentUserId=null;loginResolvedUserId=null;gate(true)}});
    setInterval(checkRemote,15000);
    const recheck=async()=>{if(!approved||!navigator.onLine)return;try{const st=await rpc('etl_register_device',{p_device_id:deviceId,p_device_name:deviceName(),p_platform:platform()});if(st!=='approved'){approved=false;sessionReady=false;showArea(st==='revoked'?'etlDeniedArea':'etlPendingArea');authMessage('এই ডিভাইসের অনুমোদন আর সক্রিয় নেই।');gate(true)}}catch(e){console.warn('Device approval check:',e.message)}};
    window.addEventListener('online',()=>{recheck();checkRemote();if(approved&&sessionReady)queueSave(localData())});document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){recheck();checkRemote()}});
  }
  async function safeInit(){try{await init()}catch(e){gate(true);showArea('etlLoginFields');setLoginButtonsEnabled(false);authMessage('Cloud Login চালু হয়নি: '+(e?.message||e));status('Cloud Login-এ সমস্যা — হিসাব সুরক্ষিত রাখা হয়েছে');console.error('Eye Touch Link auth init:',e)}}
  window.etlCloud={init:safeInit,queueSave,refreshDevices,deviceId};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',safeInit);else safeInit();
})();
