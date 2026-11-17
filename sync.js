'use strict';
const config=window.CLASSROOM_CONFIG||{}, url=String(config.projectUrl||'').replace(/\/$/,'');
const shared=['placement','lessons','checks','exam'], protectedKeys=['assigned','skip','usePlacement','notes'];
let account=null, session=null, base=null, rev=0, busy=false, scheduled, conflict=false, epoch=0, isSigningIn=false;
let statusText='', refreshing=null;
const sessionKey='ged-hosted-session:'+url, draftKey=()=>sessionKey+':draft:'+session.user.id;
const clone=x=>JSON.parse(JSON.stringify(x));
function stable(x){return x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,stable(x[k])])):Array.isArray(x)?x.map(stable):x;}
const equal=(x,y)=>JSON.stringify(stable(x))===JSON.stringify(stable(y));
const snap=s=>Object.fromEntries([...shared,...protectedKeys].map(k=>[k,clone(s[k])]));
const allowed=()=>account==='teacher'?[...shared,...protectedKeys]:shared;
const completion=()=>account==='student'&&Number.isInteger(base?.assigned)&&S.assigned===null&&S.lessons[base.assigned]?.done?base.assigned:null;
function changed(){return base&&(allowed().some(k=>!equal(S[k],base[k]))||completion()!==null);}
function setStatus(t){statusText=t;document.querySelector('#storage').textContent=t;document.querySelector('#cloudStatus').textContent=t;}
function storeSession(){try{sessionStorage.setItem(sessionKey,JSON.stringify(session));}catch{}}
function stash(){if(!account)return;try{if(changed()||conflict)sessionStorage.setItem(draftKey(),JSON.stringify({role:account,base,rev,state:snap(S)}));else sessionStorage.removeItem(draftKey());}catch{}}
function sheetSave(){if(!account)return;stash();if(changed()&&!conflict){setStatus('Saving changes…');clearTimeout(scheduled);scheduled=setTimeout(sync,380);}else if(!conflict)setStatus('Saved to your classroom');}
function gate(message=''){
 document.body.classList.add('locked');document.querySelector('#loginError').textContent=message;
 document.querySelector('#cloudLogin').hidden=false;document.querySelector('#sessionBar').hidden=true;
}
function unlock(){
 document.body.classList.remove('locked');document.querySelector('#cloudLogin').hidden=true;document.querySelector('#sessionBar').hidden=false;
 document.querySelector('#accountLabel').textContent=(account==='teacher'?'Teacher':'Student')+' account';
 document.querySelectorAll('[data-role]').forEach(b=>{b.hidden=b.dataset.role!==account;});draw();
}
function safeConfig(){return /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url)&&/^sb_publishable_[A-Za-z0-9_-]+$/.test(config.publishableKey||'');}
async function api(path,body,token){
 const headers={apikey:config.publishableKey,'Content-Type':'application/json'};if(token)headers.Authorization='Bearer '+token;
 let res=await fetch(url+path,{method:'POST',headers,body:JSON.stringify(body),cache:'no-store'});let data=await res.json().catch(()=>null);
 if(!res.ok){const e=new Error('Request failed');e.status=res.status;e.code=data?.code;e.authCode=data?.error_code;throw e;}return data;
}
function updateSession(data){session={access_token:data.access_token,refresh_token:data.refresh_token,expires_at:data.expires_at||Math.floor(Date.now()/1000)+data.expires_in,user:{id:data.user.id}};storeSession();}
async function renew(){if(!refreshing){const original=epoch;refreshing=api('/auth/v1/token?grant_type=refresh_token',{refresh_token:session.refresh_token})
 .then(s=>{if(original===epoch)updateSession(s);}).finally(()=>{refreshing=null;});}return refreshing;}
async function rpc(fn,data){if((session.expires_at||0)*1000<Date.now()+45000)await renew();try{return await api('/rest/v1/rpc/'+fn,data,session.access_token);}catch(e){if(e.status!==401)throw e;await renew();return api('/rest/v1/rpc/'+fn,data,session.access_token);}}
function normal(r){const st={...fresh(),...r.record,role:r.role};if(!valid(st)||!Number.isSafeInteger(r.revision)||r.revision<0||!['student','teacher'].includes(r.role))throw new Error('Invalid classroom record');return snap(st);}
function conflictUI(){conflict=true;stash();document.querySelector('#conflictBox').hidden=false;setStatus('Two devices changed the same work. Choose which copy to keep.');}
function adopt(r,baseline){
 const remote=normal(r);if(account!==r.role){expire('Your account role changed. Sign in again.');return false;}
 let local=snap(S), edit=allowed();const finish=completion();
 for(const k of edit){
   if(!equal(local[k],baseline[k])&&!equal(remote[k],baseline[k])&&!equal(local[k],remote[k])){conflictUI();return false;}
 }
 let redraw=false;for(const k of [...shared,...protectedKeys]){
   if(k==='assigned'&&finish!==null&&remote.assigned===finish)continue;
   if(!edit.includes(k)||equal(local[k],baseline[k])){if(!equal(S[k],remote[k])){S[k]=clone(remote[k]);redraw=true;}}
 }
 base=remote;rev=r.revision;stash();if(redraw)draw();return true;
}
async function sync(){
 if(!account||busy||conflict)return;if(!changed()&&document.activeElement?.matches('textarea,input:not([type=radio])'))return;
 const original=epoch;busy=true;
 try{
   const keys=allowed(),diff=Object.fromEntries(keys.filter(k=>!equal(S[k],base[k])).map(k=>[k,clone(S[k])])),finish=completion();
   if(Object.keys(diff).length||finish!==null){
     const sent={...clone(base),...diff};if(finish!==null)sent.assigned=null;
     const res=await rpc('ged_save',{expected_revision:rev,changes:diff,finished_lesson:finish});
     if(original!==epoch)return;
     if(!adopt(res.snapshot,res.saved?sent:base))return;
   }else{const r=await rpc('ged_read',{});if(original!==epoch)return;if(r.revision!==rev&&!adopt(r,base))return;}
   if(changed()){setStatus('Saving changes…');clearTimeout(scheduled);scheduled=setTimeout(sync,100);}else setStatus('Saved to your classroom');
 }catch(e){if(original!==epoch)return;if(e.code==='42501'){expire('Classroom access changed. Sign in again or check with the teacher.');}else if(e.status===401||e.authCode==='refresh_token_not_found'||e.authCode==='refresh_token_already_used'){expire('Your session expired. Sign in to continue syncing.');}else setStatus(changed()?'Changes pending · reconnect to save':'Connection unavailable · retrying');}
 finally{if(original===epoch)busy=false;}
}
function expire(message){stash();epoch++;account=null;session=null;base=null;busy=false;conflict=false;S=fresh();app.innerHTML='';document.querySelector('#conflictBox').hidden=true;try{sessionStorage.removeItem(sessionKey);}catch{}gate(message);}
async function openClass(){
 const old=epoch;const r=await rpc('ged_read',{});if(old!==epoch)return;
 account=r.role;base=normal(r);rev=r.revision;S={...fresh(),...clone(base),role:account};
 let d;try{d=JSON.parse(sessionStorage.getItem(draftKey()));}catch{}
 if(d&&d.role===account&&valid({...fresh(),...d.state,role:account})&&valid({...fresh(),...d.base,role:account})){
   Object.assign(S,d.state);base=d.base;rev=d.rev;adopt(r,base);
 }
 unlock();document.querySelector('#pw').value='';if(!conflict){sheetSave();sync();}
}
function errorText(e){if(e.code==='42501')return 'This account is not linked to the classroom. Check the two accounts in the setup guide.';if(e.code==='PGRST202')return 'The classroom database functions are missing. Run the first setup SQL file.';if(e.status===400||e.status===401)return 'Check the email and password, and confirm the user in Supabase Authentication.';return 'Could not connect to the classroom. Check your internet connection, project URL and publishable key.';}
async function signout(){
 if(busy){toast('A save is in progress. Try signing out when it finishes.');return;}
 if((changed()||conflict)&&!confirm('Export pending edits and sign out? The downloaded JSON will keep a copy of your unsynced work.'))return;
 if(changed()||conflict)download(new Blob([JSON.stringify(S)],{type:'application/json'}),'GED unsynced progress.json');
 const token=session?.access_token;try{sessionStorage.removeItem(draftKey());}catch{}if(account){Object.assign(S,clone(base));}
 expire('Signed out.');if(token)api('/auth/v1/logout?scope=local',{},token).catch(()=>{});
}
document.querySelector('#sessionExit').onclick=signout;
document.querySelector('#backupDraft').onclick=()=>download(new Blob([JSON.stringify(S,null,2)],{type:'application/json'}),'GED device progress.json');
document.querySelector('#loadCloud').onclick=async()=>{
 if(!confirm('Replace this device’s pending edits with the latest saved classroom record? Download the device copy first if you need it.'))return;
 try{let r=await rpc('ged_read',{});base=normal(r);rev=r.revision;S={...fresh(),...clone(base),role:account};conflict=false;stash();document.querySelector('#conflictBox').hidden=true;draw();setStatus('Saved to your classroom');}catch{setStatus('Could not reload. Your device copy is still available.');}
};
document.querySelector('#signForm').onsubmit=async ev=>{
 ev.preventDefault();if(isSigningIn||!safeConfig())return;isSigningIn=true;const b=document.querySelector('#signButton');b.disabled=true;gate('Signing in…');
 try{const s=await api('/auth/v1/token?grant_type=password',{email:document.querySelector('#email').value.trim(),password:document.querySelector('#pw').value});updateSession(s);await openClass();}
 catch(e){expire(errorText(e));}finally{isSigningIn=false;b.disabled=false;}
};
window.addEventListener('beforeunload',e=>{if(account&&(changed()||conflict)){e.preventDefault();e.returnValue='';}});
window.addEventListener('online',sync);window.addEventListener('focus',sync);
setInterval(()=>{if(account&&!document.hidden)sync();},5000);
async function boot(){if(!safeConfig()){gate('Site owner: enter your Supabase project URL and publishable key in config.js first.');document.querySelector('#signButton').disabled=true;return;}
 gate();try{const old=JSON.parse(sessionStorage.getItem(sessionKey));if(old?.refresh_token&&old?.user?.id){session=old;await openClass();}}catch(e){expire(errorText(e));}}
boot();
