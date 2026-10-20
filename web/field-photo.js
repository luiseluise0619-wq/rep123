(function(){
'use strict';
const $=id=>document.getElementById(id),config=window.PHOTO_CONFIG||{},address=new URLSearchParams(location.search).get('address')||'';
const random=bytes=>Array.from(crypto.getRandomValues(new Uint8Array(bytes)),b=>b.toString(16).padStart(2,'0')).join('');
const channel=random(32),requests=new Map(),KEY='photoDeviceKeyV4';
let remote=null,remoteOrigin='',deviceKey='',busy=false,sending=false,singlePhotoMode=false,localReady=false,addressReady=false,savedCount=0,canUpload=false,stream=null,pending=[],epoch=0,initialStatusPromise=null;
let connectResolve,connectReject;
const connected=new Promise((resolve,reject)=>{connectResolve=resolve;connectReject=reject;});
const connectionTimer=setTimeout(()=>connectReject(Error('저장 서버에 연결되지 않았습니다. 잠시 후 이 화면을 다시 열어 주세요.')),30000);
function say(text,error=false){$('message').textContent=text;$('message').hidden=!text;$('message').classList.toggle('error',error);}
function readKey(){try{const key=localStorage.getItem(KEY)||'';return /^[a-f0-9]{64}$/.test(key)?key:'';}catch(ignored){return '';}}
function keepKey(legacy){let key=readKey()||(/^[a-f0-9]{64}$/.test(legacy||'')?legacy:random(32));try{localStorage.setItem(KEY,key);return readKey()===key?key:'';}catch(ignored){return '';}}
function bridgeOrigin(value){return value==='https://script.google.com'||/^https:\/\/[a-z0-9-]+-script\.googleusercontent\.com$/.test(value);}
window.addEventListener('message',event=>{
  const data=event.data;if(!data||data.channel!==channel||!bridgeOrigin(event.origin))return;
  if(data.type==='ready'&&!remote){remote=event.source;remoteOrigin=event.origin;clearTimeout(connectionTimer);deviceKey=keepKey(data.legacyKey);connectResolve();return;}
  if(event.source!==remote||event.origin!==remoteOrigin||data.type!=='reply')return;
  const request=requests.get(data.id);if(!request)return;requests.delete(data.id);clearTimeout(request.timer);
  if(data.result&&data.result.ok)request.resolve(data.result.data);else{const error=Error(data.result&&data.result.message||'요청을 완료하지 못했습니다.');error.code=data.result&&data.result.code;request.reject(error);}
});
async function once(name,...args){await connected;return new Promise((resolve,reject)=>{
  const id=random(12),timer=setTimeout(()=>{requests.delete(id);const error=Error(name==='uploadPublicPhoto'?'등록 응답이 늦어 저장 여부를 확인하지 못했습니다. 사진은 그대로 두고 ‘등록 현황 확인’을 눌러주세요.':'서버 응답이 늦습니다. 잠시 후 다시 확인해 주세요.');error.code='TIMEOUT';reject(error);},name==='uploadPublicPhoto'?90000:30000);
  requests.set(id,{resolve,reject,timer});remote.postMessage({channel,id,name,args},remoteOrigin);
});}
async function rpc(name,...args){for(let attempt=0;;attempt++){try{return await once(name,...args);}catch(error){if(error.code!=='BUSY'||attempt>=3)throw error;await new Promise(resolve=>setTimeout(resolve,1500*(attempt+1)));}}}
function controls(){
  const needsReview=pending.some(photo=>!photo.confirmed),full=savedCount+pending.length>=2;
  $('captureTitle').textContent=stream?'사진 촬영':needsReview?'사진 확인':pending.length||savedCount?'사진 추가':'사진 촬영';
  $('captureHint').hidden=!!stream||!!pending.length;
  $('startCamera').hidden=!!stream||needsReview||full||singlePhotoMode;
  $('startCamera').textContent=pending.length||savedCount?'한 장 더 찍기':'사진 찍기';
  $('startCamera').disabled=busy||!!stream||needsReview||!localReady||(addressReady&&!canUpload)||full;
  $('confirmNext').hidden=!!stream||!needsReview||full||singlePhotoMode;
  $('confirmNext').disabled=busy||!needsReview||full||!canUpload||!deviceKey;
  $('take').disabled=busy||!stream||(addressReady&&!canUpload)||savedCount+pending.length>=2;$('stopCamera').disabled=busy;
  $('publicConsent').disabled=busy||!!stream;
  $('upload').disabled=busy||!!stream||!pending.length||!$('publicConsent').checked||!canUpload||pending.length+savedCount>2;
  $('upload').textContent=sending?'전송 중…':full?'확인하고 전송':'확인하고 1장만 전송';
  $('singlePhotoToggle').hidden=!!stream||!pending.length||full;
  $('singlePhotoToggle').disabled=busy;
  $('singlePhotoToggle').textContent=singlePhotoMode?'두 장 촬영으로 돌아가기':'한 장만 전송하기';
  $('singlePhotoToggle').setAttribute('aria-expanded',String(singlePhotoMode));
  $('refresh').disabled=busy;$('remaining').textContent=(savedCount+pending.length)+' / 2장';
  $('reviewPanel').hidden=!pending.length||!!stream;
  $('reviewHint').textContent=needsReview?(full?'사진을 확인하고 아래에서 전송해 주세요.':'사진을 확인한 뒤 한 장 더 찍거나 전송해 주세요.'):'확인한 사진입니다. 한 장 더 찍거나 전송해 주세요.';
  $('saveControls').hidden=!pending.length||!!stream||(!full&&!singlePhotoMode&&!sending);$('captureCard').hidden=!localReady||(addressReady&&savedCount>=2&&!pending.length);
  document.querySelectorAll('#pending button').forEach(button=>{button.disabled=busy;});
}
function stopCamera(){if(stream)stream.getTracks().forEach(track=>track.stop());stream=null;$('cameraVideo').srcObject=null;$('cameraPanel').hidden=true;controls();}
async function withBusy(fn){if(busy)return;busy=true;controls();try{await fn();}catch(error){say(error.message,true);}finally{busy=false;controls();}}
async function openCamera(){await withBusy(async()=>{
  if(!localReady||(addressReady&&!canUpload))throw Error('이 주소에는 지금 사진을 등록할 수 없습니다.');
  if(stream)return;
  if(pending.some(photo=>!photo.confirmed))throw Error('찍은 사진을 먼저 확인해 주세요.');
  if(savedCount+pending.length>=2)throw Error('주소당 사진은 2장까지 등록할 수 있습니다.');
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia)throw Error('카메라를 지원하는 최신 휴대폰 브라우저로 열어 주세요.');
  say('카메라를 켜는 중…');
  try{stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1600},height:{ideal:1200}},audio:false});
    if(addressReady&&(!canUpload||savedCount+pending.length>=2))throw Error('이 주소에는 지금 사진을 등록할 수 없습니다.');
    $('cameraVideo').srcObject=stream;$('cameraPanel').hidden=false;controls();await $('cameraVideo').play();
    say(addressReady?'':'등록 현황을 확인하는 중입니다. 확인이 끝나면 촬영할 수 있습니다.');$('cameraPanel').scrollIntoView({block:'start'});
  }catch(error){stopCamera();throw error.name==='NotAllowedError'?Error('카메라 권한을 허용해 주세요.'):error;}
});}
function jpeg(canvas,quality){return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(Error('사진 변환에 실패했습니다.')),'image/jpeg',quality));}
function kstDate(time){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(time);}
function stamp(video,address,when){
  const width=video.videoWidth,height=video.videoHeight;if(!width||!height)throw Error('카메라 화면을 아직 받지 못했습니다. 잠시 후 다시 촬영하세요.');
  const scale=Math.min(1,1600/Math.max(width,height)),w=Math.round(width*scale),h=Math.round(height*scale),font=Math.max(16,Math.round(w/48)),pad=font,lineHeight=Math.ceil(font*1.5),canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
  ctx.font=font+'px sans-serif';const lines=[],available=w-2*pad;let line='방문 주소: ';
  for(const char of address){if(ctx.measureText(line+char).width>available&&line){lines.push(line);line=char;}else line+=char;}if(line)lines.push(line);
  lines.unshift('촬영 기록(KST·기기 시각): '+when.toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false}));
  canvas.width=w;canvas.height=h+pad*2+lineHeight*lines.length;ctx.drawImage(video,0,0,w,h);ctx.fillStyle='#1f2937';ctx.fillRect(0,h,w,canvas.height-h);ctx.fillStyle='white';ctx.font=font+'px sans-serif';ctx.textBaseline='top';lines.forEach((text,i)=>ctx.fillText(text,pad,h+pad+i*lineHeight));return canvas;
}
async function compress(canvas){
  for(let edge=Math.min(1600,Math.max(canvas.width,canvas.height));edge>=Math.min(800,Math.max(canvas.width,canvas.height));edge=Math.floor(edge*.8)){
    const scaled=document.createElement('canvas'),factor=Math.min(1,edge/Math.max(canvas.width,canvas.height));scaled.width=Math.round(canvas.width*factor);scaled.height=Math.round(canvas.height*factor);scaled.getContext('2d').drawImage(canvas,0,0,scaled.width,scaled.height);
    for(const quality of [.86,.76,.66,.56,.46]){const blob=await jpeg(scaled,quality);if(blob.size<=200000)return blob;}
  }throw Error('사진을 줄이지 못했습니다. 구도를 바꿔 다시 촬영해 주세요.');
}
async function capture(){await withBusy(async()=>{
  if(!stream)throw Error('카메라를 먼저 켜 주세요.');
  if(!addressReady){say('등록 가능한 주소인지 확인하는 중…');await initialStatusPromise;}
  if(!stream||!canUpload||!deviceKey)throw Error('이 주소에는 지금 사진을 등록할 수 없습니다.');
  if(savedCount+pending.length>=2||pending.some(photo=>!photo.confirmed))throw Error('찍은 사진을 먼저 확인해 주세요.');say('촬영을 준비하는 중…');
  const permit=await rpc('beginPublicCapture',deviceKey,address),when=new Date();
  const canvas=stamp($('cameraVideo'),address,when);stopCamera();
  const blob=await compress(canvas),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('');
  pending.push({blob,url:URL.createObjectURL(blob),hash,ticket:permit.ticket,capturedAt:when.getTime(),visitDate:kstDate(when),confirmed:false});singlePhotoMode=false;$('publicConsent').checked=false;renderPending();
  say('');$('reviewPanel').scrollIntoView({block:'start'});
});}
function zoom(src){$('zoomImage').src=src;$('zoom').showModal();}
function discardPending(photo){const index=pending.indexOf(photo);if(index<0)return;pending.splice(index,1);URL.revokeObjectURL(photo.url);singlePhotoMode=false;$('publicConsent').checked=false;renderPending();}
function renderPending(){const cards=pending.map((photo,index)=>{
  const card=document.createElement('article');card.className='photo '+(photo.confirmed?'confirmed':'reviewing');const image=document.createElement('img');image.src=photo.url;image.alt='촬영 사진 '+(index+1);image.onclick=()=>zoom(photo.url);
  image.tabIndex=0;image.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();zoom(photo.url);}};
  const info=document.createElement('p');info.textContent='사진 '+(index+1)+(photo.confirmed?' · 확인 완료':'');card.append(image,info);
  const remove=document.createElement('button');remove.type='button';remove.className='secondary';remove.textContent=photo.confirmed?'빼기':'다시 찍기';remove.setAttribute('aria-label','사진 '+(index+1)+' '+(photo.confirmed?'빼기':'다시 찍기'));remove.onclick=async()=>{if(busy)return;const retake=!photo.confirmed;discardPending(photo);if(retake)await openCamera();};card.append(remove);return card;
});$('pending').replaceChildren(...cards);controls();}
async function confirmAndNext(){
  if(busy)return;const photo=pending.find(item=>!item.confirmed);
  if(!photo||savedCount+pending.length>=2)return;
  photo.confirmed=true;renderPending();await openCamera();
}
async function confirmAndSend(){
  if(busy||!pending.length||stream)return;
  if(!$('publicConsent').checked){say('공개 등록 안내에 체크한 뒤 전송해 주세요.',true);return;}
  pending.forEach(photo=>{photo.confirmed=true;});renderPending();await upload();
}
function savedCard(photo){const card=document.createElement('article');card.className='photo';const title=document.createElement('p');title.textContent='사진 '+photo.slot+' · 등록 '+(photo.uploadedAt?new Date(photo.uploadedAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}):'시각 기록 없음');card.append(title);
  const view=document.createElement('button');view.type='button';view.className='secondary';view.textContent='사진 보기';view.onclick=()=>withBusy(async()=>{const result=await rpc('getPublicPhoto',address,photo.id);const src='data:image/jpeg;base64,'+result.base64;const image=document.createElement('img');image.src=src;image.alt='등록 사진 '+photo.slot;image.onclick=()=>zoom(src);card.prepend(image);view.remove();});card.append(view);
  if(photo.canDelete){const remove=document.createElement('button'),confirm=document.createElement('div'),yes=document.createElement('button'),no=document.createElement('button'),notice=document.createElement('p');remove.type=yes.type=no.type='button';remove.className='danger';remove.textContent='내 사진 삭제';yes.textContent='삭제';yes.className='danger';no.textContent='취소';no.className='secondary';notice.textContent='MYBOX 휴지통으로 이동할까요?';confirm.hidden=true;confirm.append(notice,yes,no);remove.onclick=()=>{if(!busy){confirm.hidden=false;remove.hidden=true;}};no.onclick=()=>{confirm.hidden=true;remove.hidden=false;};yes.onclick=()=>withBusy(async()=>{await rpc('deletePhoto','',deviceKey,address,photo.id);await refresh();say('사진을 삭제했습니다.');});card.append(remove,confirm);}return card;
}
async function refresh(){const token=++epoch,data=await rpc('getPublicStatus',address,deviceKey);if(token!==epoch)return;if(!data.ready)throw Error('사진 저장 설정을 확인해야 합니다.');addressReady=true;savedCount=data.totalCount;canUpload=!!data.quota.canUpload&&!!deviceKey;$('count').textContent=savedCount+' / 2';$('gallery').hidden=false;$('saved').replaceChildren(...data.photos.map(savedCard));controls();return data;}
async function encode(blob){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error('사진을 읽지 못했습니다.'));reader.readAsDataURL(blob);});}
async function upload(){await withBusy(async()=>{
  if(!pending.length||pending.some(photo=>!photo.confirmed))throw Error('사진마다 ‘확인’을 누른 뒤 전송해 주세요.');
  if(!$('publicConsent').checked)throw Error('공개 등록 안내에 체크해 주세요.');sending=true;stopCamera();let saved=0;
  try{while(pending.length){const photo=pending[0];$('saveProgress').textContent=(saved+1)+'번째 사진 처리 중…';
    // A fresh upload is already idempotent on the server. Check a receipt only after an uncertain reply.
    let alreadySaved=false;
    if(photo.uncertain){say('앞선 등록 여부를 확인하는 중…');alreadySaved=(await rpc('getPublicUploadReceipt',deviceKey,address,photo.hash)).saved;}
    if(!alreadySaved){say('사진을 저장하는 중…');try{
      await rpc('uploadPublicPhoto',deviceKey,address,{base64:await encode(photo.blob),visitDate:photo.visitDate,confirmReadable:true,publicShare:true,captureTicket:photo.ticket,capturedAt:photo.capturedAt});
    }catch(error){if(['TIMEOUT','CONNECTION','UPLOAD','VERIFY'].includes(error.code)){
      photo.uncertain=true;say('저장 응답을 확인하는 중…');
      try{alreadySaved=(await rpc('getPublicUploadReceipt',deviceKey,address,photo.hash)).saved;}catch(ignored){}
      if(!alreadySaved)throw error;
    }else throw error;}}
    pending.shift();URL.revokeObjectURL(photo.url);saved++;renderPending();
  }singlePhotoMode=false;await refresh();say(saved+'장을 등록했습니다.');
  }catch(error){singlePhotoMode=!!pending.length;try{await refresh();}catch(ignored){}throw error;}finally{sending=false;$('saveProgress').textContent='';}
});}
$('publicConsent').onchange=controls;$('startCamera').onclick=openCamera;$('take').onclick=capture;$('stopCamera').onclick=stopCamera;$('confirmNext').onclick=confirmAndNext;$('upload').onclick=confirmAndSend;
$('singlePhotoToggle').onclick=()=>{if(busy)return;singlePhotoMode=!singlePhotoMode;controls();if(singlePhotoMode)$('saveControls').scrollIntoView({block:'nearest'});};
$('refresh').onclick=()=>withBusy(async()=>{await refresh();say('등록 현황을 확인했습니다.');});$('closeZoom').onclick=()=>{$('zoom').close();$('zoomImage').removeAttribute('src');};
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopCamera();});window.addEventListener('pagehide',stopCamera);
window.addEventListener('beforeunload',event=>{if(busy||pending.length){event.preventDefault();event.returnValue='';}});
window.addEventListener('storage',event=>{if(event.key===KEY||event.key===null){deviceKey=readKey();canUpload=false;stopCamera();say('브라우저 삭제키가 변경됐습니다. 이 화면을 다시 열어 주세요.',true);controls();}});
async function init(){
  $('entryLoading').hidden=false;$('retryConnection').hidden=true;
  $('address').textContent=address;$('admin').href=config.webAppUrl+'?page=admin&build='+encodeURIComponent(config.build||'v5');
  // Show the camera immediately; the server still verifies exact source membership before capture and upload.
  if(!address||address.length>1000||/[\u0000-\u001f]/.test(address))throw Error('지도에서 방문 주소를 다시 선택해 주세요.');
  $('addressMap').href='https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(address);$('addressMap').hidden=false;
  localReady=true;controls();
  initialStatusPromise=connected.then(()=>{ $('entryDetail').textContent='주소와 등록된 사진을 확인하고 있습니다.';return refresh(); });
  const bridgeUrl=new URL(config.webAppUrl);bridgeUrl.searchParams.set('page','bridge');bridgeUrl.searchParams.set('channel',channel);bridgeUrl.searchParams.set('build',config.build||'v5');$('bridge').src=bridgeUrl.toString();
  await initialStatusPromise;$('entryLoading').hidden=true;
  if(!canUpload&&stream){stopCamera();say(savedCount>=2?'이 주소에는 이미 사진 2장이 등록돼 있습니다.':'지금은 사진을 등록할 수 없습니다.',true);}
  else if(!deviceKey)say('이 브라우저에서는 보기만 가능합니다. 브라우저 저장을 허용해 주세요.',true);
  else if(!stream)say('');
  controls();
}
$('retryConnection').onclick=()=>location.reload();
function entryError(error){localReady=false;addressReady=false;canUpload=false;stopCamera();$('entryLoading').hidden=true;$('retryConnection').hidden=false;controls();say(error.message,true);}
init().catch(entryError);
})();
