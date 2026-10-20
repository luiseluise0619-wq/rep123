/** Private MYBOX index. It is a repairable snapshot, never an authorization source. */
var PHOTO_INDEX_CONTEXT_ = null;
function pendingCatalog_() {
  var props = PropertiesService.getScriptProperties().getProperties();
  return Object.keys(props).filter(function(k) { return k.indexOf('PHOTO_PENDING_') === 0; })
    .map(function(k) { return JSON.parse(props[k]); });
}
function markCatalogPending_(address) {
  return withScriptLock_(function(){
    var props = PropertiesService.getScriptProperties(), key = 'PHOTO_PENDING_' + digest_(address);
    if (!props.getProperty(key) && pendingCatalog_().length >= 100)
      fail_('CATALOG', '관리자 목록 동기화가 밀려 저장을 잠시 중단합니다. 관리자에게 알려주세요.');
    props.setProperty(key, JSON.stringify({address:address,since:new Date().toISOString()}));
  });
}
function indexContext_(create) {
  if (PHOTO_INDEX_CONTEXT_ && PHOTO_INDEX_CONTEXT_.folder) return PHOTO_INDEX_CONTEXT_;
  var folder = folder_('', PHOTO_LIMITS_.indexRootName, !!create);
  PHOTO_INDEX_CONTEXT_ = {folder:folder,files:folder ? listResources_(folder) : [],json:{}};
  return PHOTO_INDEX_CONTEXT_;
}
function indexRead_(name, fallback) {
  var context = indexContext_(false), matches = context.files.filter(function(f) { return f.name === name; });
  if(Object.prototype.hasOwnProperty.call(context.json,name))return context.json[name];
  if (!matches.length) {context.json[name]=fallback;return fallback;}
  if (matches.length !== 1 || matches[0].type !== 'file' || Number(matches[0].size) > 8000000)
    fail_('CATALOG', '관리자 목록 파일을 확인해야 합니다. 사진 원본은 보존됩니다.');
  var target = api_('/drive/files/' + encodeURIComponent(matches[0].resourceId) + '/download');
  var result = fetch_(storageUrl_(target.downloadUrl,'download'), {muteHttpExceptions:true,followRedirects:false});
  if (result.getResponseCode() !== 200) fail_('CATALOG', '관리자 목록을 불러오지 못했습니다.');
  try { context.json[name]=JSON.parse(result.getContentText('UTF-8'));return context.json[name]; }
  catch(ignored) { fail_('CATALOG', '관리자 목록 형식이 달라 동기화가 필요합니다.'); }
}
function indexWrite_(name, value) {
  if (!/^(manifest|shard-[0-9a-f]|evidence-[0-9a-f]{1,2})\.json$/.test(name)) fail_('CATALOG','허용되지 않은 목록 파일입니다.');
  var context=indexContext_(true), blob=Utilities.newBlob(JSON.stringify(value),'application/json',name), size=blob.getBytes().length;
  if (size>8000000) fail_('CATALOG','관리자 목록 크기 한도에 도달했습니다.');
  var existing=context.files.filter(function(f){return f.name===name;});
  if(existing.length>1 || existing.length===1 && existing[0].type!=='file') fail_('CATALOG','관리자 목록 이름이 중복됩니다.');
  var q=quota_();
  if(q.usedBytes+size-(existing.length?Number(existing[0].size):0)>q.stopAtBytes) fail_('STORAGE','관리자 목록 저장 공간이 부족합니다.');
  var target=api_('/drive/files','post',{parentId:context.folder,fileName:name,fileSize:size,isOverwrite:true});
  var result=fetch_(storageUrl_(target.uploadUrl,'upload'),{method:'post',muteHttpExceptions:true,followRedirects:false,payload:{Filedata:blob}});
  if(result.getResponseCode()<200 || result.getResponseCode()>=300) fail_('CATALOG','관리자 목록 저장이 지연됩니다.');
  context.files=listResources_(context.folder);
  if(!context.files.some(function(f){return f.name===name && Number(f.size)===size;})) fail_('CATALOG','관리자 목록 저장 확인이 지연됩니다.');
  context.json[name]=value;
  try {var cache=CacheService.getScriptCache();
    if(name==='manifest.json')cache.remove('public-completion-meta-v1');
    else if(/^shard-[0-9a-f]\.json$/.test(name))cache.remove('public-completion-'+name.charAt(6)+'-v1');
  } catch(ignored) {} // A cache failure must not turn a verified MYBOX write into an upload failure.
}
function manifest_() {
  var value=indexRead_('manifest.json',{v:3,shards:{},scanComplete:false,updatedAt:null});
  if(value.v!==3 || !value.shards || typeof value.shards!=='object' || Array.isArray(value.shards)) fail_('CATALOG','관리자 목록 버전을 확인해 주세요.');
  Object.keys(value.shards).forEach(function(k){var s=value.shards[k]; if(!/^[0-9a-f]$/.test(k) || !s || !Number.isInteger(s.addresses) || !Number.isInteger(s.photos) || s.addresses<0 || s.photos<s.addresses || s.photos>2*s.addresses) fail_('CATALOG','관리자 집계가 올바르지 않습니다.');});
  return value;
}
function shard_(key) {
  if(!/^[0-9a-f]$/.test(key)) fail_('CATALOG','목록 번호가 올바르지 않습니다.');
  var value=indexRead_('shard-'+key+'.json',{v:3,rows:{}});
  if(value.v!==3 || !value.rows || typeof value.rows!=='object' || Array.isArray(value.rows)) fail_('CATALOG','관리자 주소 목록을 확인해 주세요.');
  Object.keys(value.rows).forEach(function(hash){var r=value.rows[hash];
    if(!/^[0-9a-f]{64}$/.test(hash) || hash[0]!==key || !r || typeof r.address!=='string' || r.address.length>1000 || digest_(r.address)!==hash || !Array.isArray(r.photos) || r.photos.length<1 || r.photos.length>2) fail_('CATALOG','관리자 주소 목록이 올바르지 않습니다.');
  });
  return value;
}
function recordFor_(address, files, scanId) {
  var where=assertAddress_(address);
  return {address:address,province:where.province,district:where.district,dong:where.dong,
    photos:files.map(function(f){var p=publicPhoto_(f);p.ownerId=photoOwner_(f);p.evidence=evidenceFor_(address,f);return p;}),
    updatedAt:new Date().toISOString(),scanId:scanId||null};
}
function saveShard_(key, shard, manifest) {
  indexWrite_('shard-'+key+'.json',shard);
  var rows=Object.keys(shard.rows).map(function(k){return shard.rows[k];});
  manifest.shards[key]={addresses:rows.length,photos:rows.reduce(function(n,r){return n+r.photos.length;},0),
    legacy:rows.reduce(function(n,r){return n+r.photos.filter(function(p){return p.legacy;}).length;},0)};
}
function applyCatalogBatch_(entries) {
  var manifest=manifest_(), groups={}, state=scanState_(),changed=false;
  entries.forEach(function(entry){var hash=digest_(entry.address),key=hash[0];(groups[key]||(groups[key]=[])).push({entry:entry,hash:hash});});
  Object.keys(groups).forEach(function(key){var data=shard_(key),dirty=false;groups[key].forEach(function(item){
    if(item.entry.files.length){data.rows[item.hash]=recordFor_(item.entry.address,item.entry.files,state.active?state.id:null);dirty=true;}
    else if(Object.prototype.hasOwnProperty.call(data.rows,item.hash)){delete data.rows[item.hash];dirty=true;}
  });if(dirty){saveShard_(key,data,manifest);changed=true;}});
  if(changed){manifest.updatedAt=new Date().toISOString();indexWrite_('manifest.json',manifest);}
  entries.forEach(function(entry){PropertiesService.getScriptProperties().deleteProperty('PHOTO_PENDING_'+digest_(entry.address));});
}
function tryCatalogUpdate_(address,files) {
  try { markCatalogPending_(address);withLease_('catalog-index',function(){applyCatalogBatch_([{address:address,files:files}]);});return true; }
  catch(ignored) { return false; } // The photo already exists; never misreport a successful write as a failed upload.
}
function scanState_() {
  return JSON.parse(PropertiesService.getScriptProperties().getProperty('PHOTO_SCAN_V3')||'{"active":false}');
}
function scanPublic_(state) { return {active:!!state.active,phase:state.phase||'',processed:Number(state.processed||0),issues:Number(state.issues||0)}; }
function getAdminOverview(session) {
  return rpc_(function(){requireAdmin_(session);var m=manifest_(),keys=Object.keys(m.shards).sort(),state=scanState_();
    return {addresses:keys.reduce(function(n,k){return n+m.shards[k].addresses;},0),photos:keys.reduce(function(n,k){return n+m.shards[k].photos;},0),
      legacy:keys.reduce(function(n,k){return n+Number(m.shards[k].legacy||0);},0),
      chunks:keys.filter(function(k){return m.shards[k].addresses>0;}),updatedAt:m.updatedAt,
      scanComplete:!!m.scanComplete,verifiedAt:m.verifiedAt||null,scan:scanPublic_(state),pending:pendingCatalog_().length,quota:quota_()};
  });
}
function getAdminChunk(session,key) {
  return rpc_(function(){requireAdmin_(session);var data=shard_(String(key||''));
    return {rows:Object.keys(data.rows).map(function(k){return data.rows[k];})};
  });
}
// Public map progress contains only addresses with both photo slots filled.
// Cache avoids a MYBOX read on every map visit; indexWrite_ invalidates changed data.
// The catalog is a snapshot; a clicked address still checks its live folder.
function completionSummary_() {
  var cache=CacheService.getScriptCache(),key='public-completion-meta-v1',cached=cache.get(key);
  if(cached)return JSON.parse(cached);
  var m=manifest_(),value={keys:Object.keys(m.shards).filter(function(k){return m.shards[k].photos>m.shards[k].addresses;}).sort(),
    updatedAt:m.updatedAt,scanComplete:!!m.scanComplete};
  try {cache.put(key,JSON.stringify(value),300);} catch(ignored) {}
  return value;
}
function getPublicCompletionMeta() {
  return rpc_(function(){requirePublic_();var summary=completionSummary_(),pending=pendingCatalog_();
    return {keys:summary.keys,updatedAt:summary.updatedAt,scanComplete:summary.scanComplete,
      pending:pending.length,pendingAddresses:pending.map(function(item){return item.address;}).sort()};
  });
}
function getPublicCompletionChunk(key) {
  return rpc_(function(){requirePublic_();key=String(key||'');
    if(!/^[0-9a-f]$/.test(key))fail_('CATALOG','목록 번호가 올바르지 않습니다.');
    var summary=completionSummary_(),addresses=[],cache=CacheService.getScriptCache(),cacheKey='public-completion-'+key+'-v1';
    if(summary.keys.indexOf(key)<0)return {key:key,addresses:addresses,updatedAt:summary.updatedAt};
    var cached=cache.get(cacheKey);
    if(cached)addresses=JSON.parse(cached);
    else {var rows=shard_(key).rows;
      addresses=Object.keys(rows).filter(function(hash){return rows[hash].photos.length===2;})
        .map(function(hash){return rows[hash].address;});
      var value=JSON.stringify(addresses);
      try {if(Utilities.newBlob(value,'application/json').getBytes().length<90000)cache.put(cacheKey,value,300);} catch(ignored) {}
    }
    return {key:key,addresses:addresses,updatedAt:summary.updatedAt};
  });
}
function sourceAddressForFolder_(name) {
  if(!/^[0-9a-f]{64}__/.test(name)) return null;
  var hash=name.slice(0,64),label=name.slice(66),data=sourceData_(),found=null;
  Object.keys(data).some(function(s){return Object.keys(data[s]).some(function(g){return Object.keys(data[s][g]).some(function(d){return data[s][g][d].some(function(p){
    var candidate=p[2];
    if(candidate.replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').slice(0,70)!==label || digest_(candidate)!==hash)return false;
    found=candidate;return true;
  });});});});return found;
}
// App events are repaired without starting a full MYBOX folder walk.
function repairAdminCatalog(session) {
  return rpc_(function(){
    requireAdmin_(session);
    return withLease_('catalog-index',function(){
    var pending=pendingCatalog_().slice(0,4),batch=pending.map(function(p){var f=addressFolder_(p.address,false);return {address:p.address,files:f?photoFiles_(f):[]};});
    if(batch.length)applyCatalogBatch_(batch);
    return {pending:pendingCatalog_().length,processed:batch.length};
    });
  });
}
function syncAdminCatalog(session,restart) {
  return rpc_(function(){
    requireAdmin_(session);
    return withLease_('catalog-index',function(){
    var props=PropertiesService.getScriptProperties(),state=scanState_(),m;
    if(restart===true || !state.active && !manifest_().scanComplete){
      state={active:true,id:Utilities.getUuid(),phase:'folders',prefix:'',offset:0,processed:0,issues:0,prune:0,startedAt:new Date().toISOString()};
      m=manifest_();m.scanComplete=false;indexWrite_('manifest.json',m);
    }
    if(state.active && state.phase==='folders') {
      var root=folder_('',PHOTO_LIMITS_.rootName,false),shards=root?listResources_(root).filter(function(f){return f.type==='folder' && /^[0-9a-f]{2}$/.test(f.name);}).sort(function(a,b){return a.name.localeCompare(b.name);}):[];
      var next=shards.filter(function(s){return s.name>=state.prefix;})[0];
      if(!root && !Object.keys(manifest_().shards).length) {m=manifest_();m.scanComplete=true;m.verifiedAt=m.updatedAt=new Date().toISOString();indexWrite_('manifest.json',m);state.active=false;state.phase='done';}
      else if(!next) {state.phase='prune';state.prune=0;}
      else {
        if(state.prefix!==next.name){state.prefix=next.name;state.offset=0;}
        var folders=listResources_(next.resourceId).sort(function(a,b){return a.name.localeCompare(b.name);}),entries=[];
        folders.slice(state.offset,state.offset+4).forEach(function(folder){
          var address=folder.type==='folder' && sourceAddressForFolder_(folder.name);
          if(!address){state.issues++;return;}
          try {entries.push({address:address,files:photoFiles_(folder.resourceId)});}
          catch(error){if(['MANUAL_CHANGE','SLOT_CONFLICT'].indexOf(error.photoCode)<0)throw error;state.issues++;}
          state.processed++;
        });
        if(entries.length)applyCatalogBatch_(entries);
        state.offset+=4;
        if(state.offset>=folders.length){var n=parseInt(next.name,16)+1;state.prefix=n<256?('0'+n.toString(16)).slice(-2):'zz';state.offset=0;}
      }
    } else if(state.active && state.phase==='prune') {
      // Remove stale snapshot entries after a full scan, but preserve new uploads made during it.
      m=manifest_();var checked=0;
      while(state.prune<16){
        var key=state.prune.toString(16),summary=m.shards[key];
        // Empty shards cannot contribute a stale visible row. Avoid sixteen
        // downloads and rewrites when there are no registered photos.
        if(!summary||summary.addresses===0){state.prune++;continue;}
        if(checked>=2)break;
        var data=shard_(key),dirty=false;checked++;
        Object.keys(data.rows).forEach(function(hash){var r=data.rows[hash];if(r.scanId!==state.id && r.updatedAt<state.startedAt){delete data.rows[hash];dirty=true;}});
        if(dirty)saveShard_(key,data,m);state.prune++;
      }
      if(state.prune>=16){state.active=false;state.phase='done';m.scanComplete=state.issues===0;if(m.scanComplete)m.verifiedAt=new Date().toISOString();}
      m.updatedAt=new Date().toISOString();indexWrite_('manifest.json',m);
    } else {
      var pending=pendingCatalog_().slice(0,4),batch=pending.map(function(p){var f=addressFolder_(p.address,false);return {address:p.address,files:f?photoFiles_(f):[]};});
      if(batch.length)applyCatalogBatch_(batch);
    }
    props.setProperty('PHOTO_SCAN_V3',JSON.stringify(state));
    return {scan:scanPublic_(state),pending:pendingCatalog_().length};
    });
  });
}
