'use strict';
// MYBOX is the source of truth. Browser uploads go only to an isolated staging
// folder; a verified file is moved into the two-slot address folder under lock.
const {createHash,createHmac,randomUUID,timingSafeEqual}=require('node:crypto');
const fs=require('node:fs');
const API='https://open-api.mybox.naver.com/v1';
const ROOT='현장방문_주소사진_v1',INDEX='현장방문_사진목록_v3';
const STAGE='현장방문_직접전송대기_v1',LOCKS='현장방문_직접전송잠금_v1',PENDING='현장방문_목록반영대기_v1';
const MAX_BYTES=200000,MAX_SLOTS=2,RESERVE=1000000000;
const sha=value=>createHash('sha256').update(value).digest('hex');
const error=(code,status,message)=>Object.assign(new Error(message),{code,status});
const same=(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&timingSafeEqual(x,y);};
let cachedSource;
function source(){
  if(cachedSource)return cachedSource;
  const raw=fs.readFileSync(require.resolve('../../addresses.js'),'utf8').trim();
  const prefix='window.ADDR_DATA = ';
  if(!raw.startsWith(prefix))throw error('SOURCE',503,'원주소 자료를 읽을 수 없습니다.');
  const data=JSON.parse(raw.slice(prefix.length).replace(/;\s*$/,'')),map=new Map(),hashes=new Map();
  for(const [province,groups] of Object.entries(data))for(const [district,dongs] of Object.entries(groups))
    for(const [dong,places] of Object.entries(dongs))for(const place of places){
      const address=place[2];if(map.has(address))throw error('SOURCE',503,'원주소에 중복이 있습니다.');
      const businessCount=Number(place[3]);
      if(!Number.isSafeInteger(businessCount)||businessCount<1)throw error('SOURCE',503,'원주소 사업자수를 확인해야 합니다.');
      map.set(address,{province,district,dong,businessCount});hashes.set(sha(address),address);
    }
  cachedSource={map,hashes};return cachedSource;
}
function checkAddress(address){
  if(typeof address!=='string'||!address||address.length>1000||!source().map.has(address))
    throw error('ADDRESS',400,'지도에서 방문 주소를 다시 선택해 주세요.');
  return source().map.get(address);
}
function actor(deviceKey){
  if(typeof deviceKey!=='string'||!/^[a-f0-9]{64}$/.test(deviceKey))
    throw error('DEVICE',400,'이 브라우저의 삭제키를 저장할 수 없어 등록할 수 없습니다.');
  return sha('photo-device-v4\n'+deviceKey).slice(0,32);
}
function sign(token,kind,value){
  const body=Buffer.from(JSON.stringify(value)).toString('base64url');
  return body+'.'+createHmac('sha256',token).update('photo-direct-v1\n'+kind+'\n'+body).digest('hex');
}
function verify(token,kind,signed,clock=Date.now){
  const parts=String(signed||'').split('.');
  if(parts.length!==2||parts[0].length>5000||!same(parts[1],createHmac('sha256',token).update('photo-direct-v1\n'+kind+'\n'+parts[0]).digest('hex')))
    throw error('TICKET',403,'촬영·전송 정보가 올바르지 않습니다. 다시 촬영해 주세요.');
  let data;try{data=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));}catch{throw error('TICKET',403,'촬영·전송 정보를 확인할 수 없습니다.');}
  if(!Number.isFinite(data.exp)||data.exp<clock())throw error('EXPIRED',409,'전송 시간이 지나 다시 촬영해야 합니다.');
  return data;
}
function safeUrl(value,kind){
  if(typeof value!=='string'||value.length>2000||!/^https:\/\/[a-z0-9.-]+(?::443)?\/v1\/storage\/(upload|download)\?/i.test(value)||!value.includes('/v1/storage/'+kind+'?'))
    throw error('MYBOX_URL',502,'MYBOX 저장 주소가 올바르지 않습니다.');
  return value;
}
function validJpeg(bytes){
  if(!Buffer.isBuffer(bytes)||bytes.length<32||bytes.length>MAX_BYTES||bytes[0]!==255||bytes[1]!==216||bytes.at(-2)!==255||bytes.at(-1)!==217)
    throw error('JPEG',400,'사진 파일을 확인할 수 없습니다.');
  let offset=2,dimension=false;
  while(offset+4<=bytes.length){
    if(bytes[offset]!==255)break;
    const marker=bytes[offset+1];if(marker===218)break;
    const length=bytes.readUInt16BE(offset+2);if(length<2||offset+2+length>bytes.length)throw error('JPEG',400,'손상된 사진입니다.');
    if(marker===192||marker===194){
      const height=length>=8?bytes.readUInt16BE(offset+5):0,width=length>=8?bytes.readUInt16BE(offset+7):0;
      if(!height||!width||Math.max(height,width)>1600)throw error('JPEG',400,'사진 크기를 확인해 주세요.');
      dimension=true;
    }
    const icc=marker===226&&length<=4096&&bytes.subarray(offset+4,offset+16).toString('latin1').startsWith('ICC_PROFILE\0');
    if(!icc&&((marker>=225&&marker<=237)||marker===239||marker===254))throw error('METADATA',400,'위치·개인정보 메타데이터가 있는 사진은 등록할 수 없습니다.');
    offset+=length+2;
  }
  if(!dimension)throw error('JPEG',400,'사진 크기 정보를 찾지 못했습니다.');
}
function createService({token,adminPassword='',fetcher=fetch,now=()=>Date.now(),lookup=source}={}){
  token=String(token||'').trim().replace(/^Bearer\s+/i,'').trim();
  if(!token)throw error('SETUP',503,'MYBOX 연결을 확인해야 합니다.');
  async function api(path,method='GET',body){
    const response=await fetcher(API+path,{method,redirect:'manual',signal:AbortSignal.timeout(30000),
      headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    if(response.status===401||response.status===403)throw error('MYBOX_AUTH',502,'MYBOX 인증키를 확인해야 합니다.');
    if(response.status===429)throw error('RATE_LIMIT',503,'MYBOX 요청이 많습니다. 잠시 후 다시 시도해 주세요.');
    if(response.status===507)throw error('STORAGE',507,'MYBOX 저장 공간이 부족합니다.');
    if(!response.ok)throw error('MYBOX',502,'MYBOX 요청을 완료하지 못했습니다. HTTP '+response.status);
    if(response.status===204)return {};
    const raw=await response.text();
    if(!raw)return {};
    try{return JSON.parse(raw);}catch{throw error('MYBOX',502,'MYBOX 응답 형식을 확인하지 못했습니다.');}
  }
  async function list(parent){
    const result=[];let cursor='';
    for(let page=0;page<100;page++){
      const path=parent?'/drive/folders/'+encodeURIComponent(parent)+'/resources':'/drive/resources';
      const data=await api(path+'?count=1000'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
      if(!Array.isArray(data.resources))throw error('MYBOX',502,'MYBOX 목록 형식이 올바르지 않습니다.');
      result.push(...data.resources);cursor=data.responseMetaData?.nextCursor||'';
      if(!cursor)return result;
    }
    throw error('MYBOX',502,'MYBOX 폴더에 항목이 너무 많습니다.');
  }
  async function folder(parent,name,create=false){
    let matches=(await list(parent)).filter(item=>item.name===name);
    if(matches.length>1||matches.length===1&&matches[0].type!=='folder')throw error('FOLDER',409,'사진 폴더의 중복 항목을 확인해야 합니다.');
    if(matches.length)return matches[0].resourceId;
    if(!create)return null;
    try{const data=await api('/drive/folders','POST',{folderName:name,...(parent?{parentId:parent}:{})});
      if(!data.resourceId)throw error('FOLDER',502,'MYBOX 폴더 생성 결과를 확인하지 못했습니다.');return data.resourceId;}
    catch(e){if(e.code!=='MYBOX'||!String(e.message).includes('409'))throw e;
      matches=(await list(parent)).filter(item=>item.name===name&&item.type==='folder');
      if(matches.length!==1)throw error('FOLDER',409,'사진 폴더를 확인할 수 없습니다.');return matches[0].resourceId;}
  }
  async function addressFolder(address,create=false){
    const hash=sha(address),root=await folder('',ROOT,create);if(!root)return null;
    const shard=await folder(root,hash.slice(0,2),create);if(!shard)return null;
    const label=address.replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').slice(0,70);
    return folder(shard,hash+'__'+label,create);
  }
  async function photoFiles(parent){
    if(!parent)return [];
    const files=await list(parent);
    if(files.length>2||files.some(f=>f.type!=='file'||!(/^[12]__[a-f0-9]{64}__\d{8}T\d{9}Z__\d{4}-\d{2}-\d{2}__.+\.jpg$/.test(f.name)))||new Set(files.map(f=>f.name[0])).size!==files.length)
      throw error('MANUAL_CHANGE',409,'이 주소의 사진 폴더를 관리자가 확인해야 합니다.');
    return files.sort((a,b)=>a.name.localeCompare(b.name));
  }
  async function quota(){
    const q=await api('/drive/storage');const total=Number(q.quotaBytes),used=Number(q.usedBytes);
    if(!Number.isFinite(total)||!Number.isFinite(used)||total<1||used<0)throw error('QUOTA',502,'저장 공간을 확인하지 못했습니다.');
    const stopAt=Math.max(0,total-RESERVE);
    return {canUpload:used+MAX_BYTES<=stopAt,usedBytes:used,remainingSafeBytes:Math.max(0,stopAt-used)};
  }
  async function lock(scope,work){
    const hash=sha(scope),root=await folder('',LOCKS,true),shard=await folder(root,hash.slice(0,2),true);
    let lease;
    try{lease=await api('/drive/folders','POST',{parentId:shard,folderName:hash});}
    catch(e){
      if(e.code!=='MYBOX'||!String(e.message).includes('409'))throw e;
      const held=(await list(shard)).filter(item=>item.name===hash&&item.type==='folder');
      if(held.length!==1||!held[0].createdAt||now()-Date.parse(held[0].createdAt)<180000)
        throw error('BUSY',409,'이 주소의 작업이 진행 중입니다. 잠시 후 다시 시도하세요.');
      await api('/drive/resources/'+encodeURIComponent(held[0].resourceId),'DELETE');
      try{lease=await api('/drive/folders','POST',{parentId:shard,folderName:hash});}
      catch{throw error('BUSY',409,'이 주소의 작업이 진행 중입니다. 잠시 후 다시 시도하세요.');}
    }
    if(!lease?.resourceId)throw error('LOCK',502,'MYBOX 잠금 결과를 확인하지 못했습니다.');
    try{return await work();}
    finally{try{await api('/drive/resources/'+encodeURIComponent(lease.resourceId),'DELETE');}
      catch(e){console.warn(JSON.stringify({event:'direct_lock_release_failed',scope:sha(scope).slice(0,12),code:e.code}));}}
  }
  function entry(file,owner){
    const parts=file.name.split('__'),id=sha(String(file.resourceId)+'\n'+file.name),ownerId=/^(?:v4d|v3u)-([a-f0-9]{32})$/.exec(parts[4]||'')?.[1]||'';
    const t=parts[2].replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/,'$1-$2-$3T$4:$5:$6.$7Z');
    return {id,slot:Number(parts[0]),visitDate:parts[3],uploadedAt:Number.isNaN(Date.parse(t))?file.createdAt||file.createdTime||null:t,
      bytes:Number(file.size),canDelete:!!owner&&parts[4]==='v4d-'+owner,ownerId,legacy:!ownerId,uploader:parts.slice(ownerId?5:4).join('__').replace(/\.jpg$/,'')};
  }
  function owned(file,owner){return !!owner&&String(file.name).split('__')[4]==='v4d-'+owner;}
  async function status(address,deviceKey){
    checkAddress(address);const owner=/^[a-f0-9]{64}$/.test(deviceKey||'')?actor(deviceKey):'';
    const files=await photoFiles(await addressFolder(address,false));const q=await quota();
    return {ready:true,totalCount:files.length,photos:files.map(f=>{const p=entry(f,owner);delete p.ownerId;delete p.uploader;delete p.legacy;return p;}),quota:{canUpload:q.canUpload}};
  }
  async function capture(address,deviceKey){
    checkAddress(address);const owner=actor(deviceKey),issued=now();
    return {ticket:sign(token,'capture',{address,owner,issued,exp:issued+600000,nonce:randomUUID()}),expiresAt:issued+600000};
  }
  function checkCapture(address,owner,ticket,capturedAt){
    const data=verify(token,'capture',ticket,now),at=Number(capturedAt);
    if(data.address!==address||data.owner!==owner||!Number.isFinite(at)||at<data.issued-30000||at>now()+30000||now()-at>600000)
      throw error('CAPTURE',403,'촬영 정보가 만료됐습니다. 다시 촬영해 주세요.');
    return {source:'live-camera-no-location',locationCollected:false,capturedAt:new Date(at).toISOString(),receivedAt:new Date(now()).toISOString(),proofOfVisit:false};
  }
  async function readBytes(file){
    const link=await api('/drive/files/'+encodeURIComponent(file.resourceId)+'/download');
    const response=await fetcher(safeUrl(link.downloadUrl,'download'),{redirect:'manual',signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw error('DOWNLOAD',502,'저장된 파일을 읽지 못했습니다.');
    const bytes=Buffer.from(await response.arrayBuffer());
    if(bytes.length!==Number(file.size)||bytes.length>8000000)throw error('VERIFY',502,'저장된 파일의 크기가 다릅니다.');
    return bytes;
  }
  async function uploadBytes(parent,name,bytes,overwrite,mime='application/json'){
    const target=await api('/drive/files','POST',{parentId:parent,fileName:name,fileSize:bytes.length,isOverwrite:overwrite});
    const form=new FormData();form.append('Filedata',new Blob([bytes],{type:mime}),name);
    const response=await fetcher(safeUrl(target.uploadUrl,'upload'),{method:'POST',body:form,redirect:'manual',signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw error('CATALOG',502,'사진 목록을 저장하지 못했습니다.');
    const found=(await list(parent)).filter(file=>file.name===name&&Number(file.size)===bytes.length);
    if(found.length!==1)throw error('CATALOG',502,'사진 목록의 저장 결과를 확인하지 못했습니다.');
  }
  async function scopedParent(rootName,address,create){
    const hash=sha(address),root=await folder('',rootName,create);if(!root)return null;
    const shard=await folder(root,hash.slice(0,2),create);if(!shard)return null;
    return folder(shard,hash,create);
  }
  async function markPending(address){await scopedParent(PENDING,address,true);}
  async function clearPending(address){
    const marker=await scopedParent(PENDING,address,false);
    if(marker)await api('/drive/resources/'+encodeURIComponent(marker),'DELETE');
  }
  async function stageParent(address,create){return scopedParent(STAGE,address,create);}
  async function receipt(address,deviceKey,imageHash){
    checkAddress(address);const owner=actor(deviceKey);
    if(typeof imageHash!=='string'||!/^[a-f0-9]{64}$/.test(imageHash))throw error('HASH',400,'사진 확인 번호가 올바르지 않습니다.');
    const files=await photoFiles(await addressFolder(address,false));
    return {saved:files.some(f=>f.name.split('__')[1]===imageHash&&owned(f,owner))};
  }
  async function reserve({address,deviceKey,hash,size,visitDate,captureTicket,capturedAt,consent}){
    checkAddress(address);const owner=actor(deviceKey);
    if(consent!==true)throw error('CONSENT',400,'사진 공개 안내에 동의해 주세요.');
    if(typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash)||!Number.isInteger(size)||size<32||size>MAX_BYTES||
      typeof visitDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(visitDate)||
      !Number.isFinite(Date.parse(visitDate+'T00:00:00Z'))||new Date(visitDate+'T00:00:00Z').toISOString().slice(0,10)!==visitDate||
      visitDate<'2000-01-01'||visitDate>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(now()))
      throw error('PHOTO',400,'사진 정보를 확인할 수 없습니다.');
    const evidence=checkCapture(address,owner,captureTicket,capturedAt);
    return lock('address:'+sha(address),async()=>{
      const existing=await photoFiles(await addressFolder(address,false));
      const duplicate=existing.find(f=>f.name.split('__')[1]===hash);
      if(duplicate){if(!owned(duplicate,owner))throw error('DUPLICATE',409,'같은 사진이 이미 등록돼 있습니다.');
        return {alreadySaved:true,photo:entry(duplicate,owner)};}
      if(existing.length>=MAX_SLOTS)throw error('FULL',409,'이 주소에는 이미 사진 2장이 있습니다.');
      const q=await quota();if(!q.canUpload||q.remainingSafeBytes<size)throw error('STORAGE',507,'MYBOX의 안전 저장 공간이 부족합니다.');
      const parent=await stageParent(address,true),sessions=await list(parent);
      for(const item of sessions){
        if(item.type!=='folder'||!item.createdAt)throw error('STAGE',409,'대기 중인 사진 폴더를 확인해야 합니다.');
        if(now()-Date.parse(item.createdAt)>600000)await api('/drive/resources/'+encodeURIComponent(item.resourceId),'DELETE');
      }
      const active=(await list(parent)).length;
      if(existing.length+active>=MAX_SLOTS)throw error('BUSY',409,'이 주소의 다른 사진 전송이 진행 중입니다. 잠시 후 다시 시도하세요.');
      const session=await api('/drive/folders','POST',{parentId:parent,folderName:randomUUID()});
      try{
        const target=await api('/drive/files','POST',{parentId:session.resourceId,fileName:'pending.jpg',fileSize:size,isOverwrite:false});
        return {uploadUrl:safeUrl(target.uploadUrl,'upload'),reservation:sign(token,'reservation',{
          address,owner,hash,size,visitDate,evidence,session:session.resourceId,exp:now()+600000})};
      }catch(e){try{await api('/drive/resources/'+encodeURIComponent(session.resourceId),'DELETE');}catch{}throw e;}
    });
  }
  async function finish({reservation,deviceKey}){
    const data=verify(token,'reservation',reservation,now),owner=actor(deviceKey),address=data.address;
    checkAddress(address);if(owner!==data.owner||!/^[a-f0-9]{64}$/.test(data.hash)||!Number.isInteger(data.size)||data.size>MAX_BYTES)
      throw error('TICKET',403,'전송 정보가 올바르지 않습니다.');
    return lock('address:'+sha(address),async()=>{
      let files=await photoFiles(await addressFolder(address,false));
      const existing=files.find(f=>f.name.split('__')[1]===data.hash&&owned(f,owner));
      if(existing)return {saved:true,alreadySaved:true,photo:entry(existing,owner),count:files.length};
      if(files.length>=MAX_SLOTS)throw error('FULL',409,'이 주소에는 이미 사진 2장이 있습니다.');
      const staged=await list(data.session),candidate=staged.filter(f=>f.type==='file'&&Number(f.size)===data.size&&
        (f.name==='pending.jpg'||/^[12]__[a-f0-9]{64}__\d{8}T\d{9}Z__\d{4}-\d{2}-\d{2}__v4d-[a-f0-9]{32}__.+\.jpg$/.test(f.name)));
      if(candidate.length!==1)throw error('PENDING',409,'전송된 사진을 아직 확인하지 못했습니다. 잠시 후 다시 확인해 주세요.');
      const bytes=await readBytes(candidate[0]);validJpeg(bytes);
      if(sha(bytes)!==data.hash)throw error('HASH',409,'전송된 사진이 촬영한 사진과 다릅니다. 다시 촬영해 주세요.');
      const slot=files.some(f=>f.name.startsWith('1__'))?2:1;
      const timestamp=new Date(now()).toISOString().replace(/[-:.]/g,'');
      const name=slot+'__'+data.hash+'__'+timestamp+'__'+data.visitDate+'__v4d-'+owner+'__현장등록.jpg';
      if(candidate[0].name!==name){await api('/drive/resources/'+encodeURIComponent(candidate[0].resourceId)+'/rename','POST',{name});}
      await markPending(address);
      const dest=await addressFolder(address,true);
      await api('/drive/resources/'+encodeURIComponent(candidate[0].resourceId)+'/move','POST',{parentId:dest,isOverwrite:false});
      files=await photoFiles(dest);
      const saved=files.find(f=>f.resourceId===candidate[0].resourceId&&f.name===name&&Number(f.size)===data.size);
      if(!saved)throw error('VERIFY',409,'사진 저장 결과를 확인 중입니다. 등록 현황을 다시 확인해 주세요.');
      try{await api('/drive/resources/'+encodeURIComponent(data.session),'DELETE');}catch{}
      let catalogPending=false;
      try{await updateCatalog(address,files,{[sha(String(saved.resourceId)+'\n'+saved.name)]:data.evidence});await clearPending(address);}
      catch(e){catalogPending=true;console.warn(JSON.stringify({event:'direct_catalog_pending',addressHash:sha(address).slice(0,12),code:e.code||'SERVICE'}));}
      const photo=entry(saved,owner);delete photo.ownerId;delete photo.uploader;
      return {saved:true,alreadySaved:false,photo,count:files.length,catalogPending};
    });
  }
  async function indexRoot(create){return folder('',INDEX,create);}
  async function readIndex(name,fallback){
    const root=await indexRoot(false);if(!root)return fallback;
    const found=(await list(root)).filter(f=>f.name===name);
    if(found.length===0)return fallback;
    if(found.length!==1||found[0].type!=='file'||Number(found[0].size)>8000000)
      throw error('CATALOG',409,'사진 목록 파일을 확인해야 합니다.');
    let value;try{value=JSON.parse((await readBytes(found[0])).toString('utf8'));}
    catch(e){if(e.code)throw e;throw error('CATALOG',409,'사진 목록 내용을 읽을 수 없습니다.');}
    return value;
  }
  async function writeIndex(name,value){
    if(!/^(manifest|shard-[a-f0-9])\.json$/.test(name))throw error('CATALOG',400,'사진 목록 이름이 올바르지 않습니다.');
    const bytes=Buffer.from(JSON.stringify(value));
    if(bytes.length>8000000)throw error('CATALOG',507,'사진 목록 파일이 너무 큽니다.');
    await uploadBytes(await indexRoot(true),name,bytes,true);
  }
  async function manifest(){
    const value=await readIndex('manifest.json',{v:3,shards:{},scanComplete:false,updatedAt:null});
    if(value?.v!==3||!value.shards||typeof value.shards!=='object'||Array.isArray(value.shards))
      throw error('CATALOG',409,'사진 목록 버전을 확인해야 합니다.');
    return value;
  }
  async function shard(key){
    if(!/^[a-f0-9]$/.test(key))throw error('CATALOG',400,'사진 목록 번호가 올바르지 않습니다.');
    const value=await readIndex('shard-'+key+'.json',{v:3,rows:{}});
    if(value?.v!==3||!value.rows||typeof value.rows!=='object'||Array.isArray(value.rows))
      throw error('CATALOG',409,'사진 주소 목록을 확인해야 합니다.');
    return value;
  }
  async function updateCatalog(address,files,evidence={}){
    const hash=sha(address),key=hash[0];
    // Protect the shard and manifest as one transaction across all addresses.
    const work=async()=>{
      const data=await shard(key),old=data.rows[hash],prior=new Map((old?.photos||[]).map(p=>[p.id,p]));
      if(files.length){
        const where=checkAddress(address);
        data.rows[hash]={address,...where,photos:files.map(file=>{
          const p=entry(file),before=prior.get(p.id);
          p.evidence=evidence[p.id]||before?.evidence||null;
          return p;
        }),updatedAt:new Date(now()).toISOString(),scanId:null};
      }else delete data.rows[hash];
      const m=await manifest(),rows=Object.values(data.rows);
      await writeIndex('shard-'+key+'.json',data);
      m.shards[key]={addresses:rows.length,photos:rows.reduce((n,r)=>n+r.photos.length,0),
        legacy:rows.reduce((n,r)=>n+r.photos.filter(p=>p.legacy).length,0)};
      m.updatedAt=new Date(now()).toISOString();await writeIndex('manifest.json',m);
      return m;
    };
    // A different address may be committing at this instant. Wait briefly for
    // the shared index instead of leaving an avoidable repair marker.
    for(let attempt=0;attempt<4;attempt++){
      try{return await lock('catalog:index',work);}
      catch(e){if(e.code!=='BUSY'||attempt===3)throw e;
        await new Promise(resolve=>setTimeout(resolve,300*(attempt+1)));}
    }
  }
  async function pendingAddresses(){
    const root=await folder('',PENDING,false);if(!root)return [];
    const all=[];
    for(const key of await list(root)){
      if(key.type!=='folder'||!/^[a-f0-9]{2}$/.test(key.name))throw error('CATALOG',409,'사진 반영 대기 폴더를 확인해야 합니다.');
      for(const item of await list(key.resourceId)){
        if(item.type!=='folder'||!/^[a-f0-9]{64}$/.test(item.name))throw error('CATALOG',409,'사진 반영 대기 항목을 확인해야 합니다.');
        const address=source().hashes.get(item.name);if(!address)throw error('CATALOG',409,'원주소에 없는 반영 대기 항목입니다.');
        all.push(address);
      }
    }
    return all;
  }
  async function repairPending(limit=10){
    const addresses=(await pendingAddresses()).slice(0,Math.max(1,Math.min(20,limit))),results=[];
    for(const address of addresses){
      try{await lock('address:'+sha(address),async()=>{
        const files=await photoFiles(await addressFolder(address,false));
        await updateCatalog(address,files);await clearPending(address);
      });results.push({address,saved:true});}
      catch(e){results.push({address,saved:false,code:e.code||'SERVICE'});}
    }
    return {processed:results.length,remaining:(await pendingAddresses()).length,results};
  }
  async function overview(){
    const m=await manifest(),keys=Object.keys(m.shards).sort(),q=await quota(),pending=await pendingAddresses();
    return {addresses:keys.reduce((n,k)=>n+m.shards[k].addresses,0),
      photos:keys.reduce((n,k)=>n+m.shards[k].photos,0),
      legacy:keys.reduce((n,k)=>n+Number(m.shards[k].legacy||0),0),
      chunks:keys.filter(k=>m.shards[k].addresses>0),updatedAt:m.updatedAt,
      scanComplete:!!m.scanComplete,verifiedAt:m.verifiedAt||null,pending:pending.length,
      quota:{usedBytes:q.usedBytes,remainingSafeBytes:q.remainingSafeBytes}};
  }
  async function chunk(key){return {rows:Object.values((await shard(key)).rows)};}
  async function completionMeta(){
    const m=await manifest(),pending=await pendingAddresses();
    return {keys:Object.keys(m.shards).filter(k=>m.shards[k].photos>m.shards[k].addresses).sort(),
      updatedAt:m.updatedAt,scanComplete:!!m.scanComplete,pending:pending.length,pendingAddresses:pending};
  }
  async function completionChunk(key){
    const m=await manifest(),data=await shard(key);
    return {key,addresses:Object.values(data.rows).filter(row=>row.photos.length===2).map(row=>row.address),updatedAt:m.updatedAt};
  }
  async function publicPhoto(address,photoId){
    checkAddress(address);if(typeof photoId!=='string'||!/^[a-f0-9]{64}$/.test(photoId))throw error('PHOTO_ID',400,'사진 번호를 확인해 주세요.');
    const files=await photoFiles(await addressFolder(address,false)),file=files.find(f=>entry(f).id===photoId);
    if(!file)throw error('NOT_FOUND',404,'저장된 사진이 없습니다.');
    const bytes=await readBytes(file);validJpeg(bytes);
    const photo=entry(file);delete photo.ownerId;delete photo.uploader;
    return {base64:bytes.toString('base64'),photo};
  }
  async function remove({address,photoId,deviceKey,admin=false}){
    checkAddress(address);if(typeof photoId!=='string'||!/^[a-f0-9]{64}$/.test(photoId))throw error('PHOTO_ID',400,'사진 번호를 확인해 주세요.');
    const owner=admin?'':actor(deviceKey);
    return lock('address:'+sha(address),async()=>{
      const parent=await addressFolder(address,false),files=await photoFiles(parent),file=files.find(f=>entry(f).id===photoId);
      if(!file)return {deleted:true,alreadyDeleted:true};
      if(!admin&&!owned(file,owner))throw error('FORBIDDEN',403,'관리자 또는 올린 브라우저에서만 삭제할 수 있습니다.');
      await markPending(address);
      await api('/drive/resources/'+encodeURIComponent(file.resourceId),'DELETE');
      const after=await photoFiles(parent);
      if(after.some(f=>f.resourceId===file.resourceId))throw error('VERIFY',409,'삭제 결과를 확인 중입니다. 새로고침해 주세요.');
      let catalogPending=false;
      try{await updateCatalog(address,after);await clearPending(address);}catch{catalogPending=true;}
      return {deleted:true,alreadyDeleted:false,catalogPending};
    });
  }
  function adminLogin(password){
    if(typeof adminPassword!=='string'||adminPassword.length<8)throw error('SETUP',503,'관리자 암호를 설정해야 합니다.');
    if(typeof password!=='string'||!same(password,adminPassword))throw error('LOGIN',403,'관리자 암호를 확인해 주세요.');
    return {session:sign(token,'admin',{role:'admin',exp:now()+8*3600000,nonce:randomUUID()}),expiresAt:now()+8*3600000};
  }
  function requireAdmin(session){const value=verify(token,'admin',session,now);if(value.role!=='admin')throw error('FORBIDDEN',403,'관리자만 이용할 수 있습니다.');}
  return {api,list,folder,addressFolder,photoFiles,quota,lock,entry,owned,status,capture,checkCapture,
    readBytes,uploadBytes,reserve,finish,receipt,publicPhoto,remove,overview,chunk,completionMeta,completionChunk,
    repairPending,adminLogin,requireAdmin,token,lookup};
}
module.exports={createService,source,checkAddress,actor,sha,sign,verify,safeUrl,validJpeg,error,
  ROOT,INDEX,STAGE,LOCKS,PENDING,MAX_BYTES,MAX_SLOTS};
