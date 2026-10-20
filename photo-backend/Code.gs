/** MYBOX photo gateway. No photos are stored in Google Drive.
 * Secrets belong in Script Properties, never in this source or the website.
 * Public RPC functions are deliberately limited; private helpers end in _.
 */
var PHOTO_LIMITS_ = Object.freeze({
  maxBytes: 200000, maxEdge: 1600, slots: 2,
  accountCeilingBytes: 24000000000, reserveBytes: 1000000000,
  sessionHours: 8,
  sourceUrl: 'https://rep123-seven.vercel.app/addresses.js',
  rootName: '현장방문_주소사진_v1', indexRootName: '현장방문_사진목록_v3', version: '2026-10-20-mybox-v12-address-concurrency', publicEnabled: true, requireCapture: true, requireLocation: false,
  webAppUrl: 'https://script.google.com/macros/s/AKfycbxkluXWRelyVJ1D0XtuLHHo1GdF76Dzp4CLHQeC-hlvpW6WmctvD9_60WKqugmfN_PAQw/exec'
});

function doGet(e) {
  var address = String(e && e.parameter && e.parameter.address || '').slice(0, 1000);
  var admin = !!(e && e.parameter && e.parameter.page === 'admin');
  var bridge = !!(e && e.parameter && e.parameter.page === 'bridge');
  var template = HtmlService.createTemplate(bridge ? PHOTO_BRIDGE_HTML_ : admin ? PHOTO_ADMIN_HTML_ : PHOTO_LANDING_HTML_);
  template.initialJson = JSON.stringify({address: address, maxBytes: PHOTO_LIMITS_.maxBytes,
    maxEdge: PHOTO_LIMITS_.maxEdge, version: PHOTO_LIMITS_.version, webAppUrl: PHOTO_LIMITS_.webAppUrl,
    channel: bridge ? String(e.parameter.channel||'').replace(/[^a-f0-9]/g,'').slice(0,64) : ''})
    .replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  var output=template.evaluate().setTitle(admin ? '방문 사진 관리자 · MYBOX' : '현장 방문 사진 · MYBOX')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  if(bridge)output.setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  return output;
}

function getStatus(session, address, identityOnly) {
  return rpc_(function() {
    var ready = configured_();
    if (!ready) return {ready: false, authenticated: false, setupProblems: setupProblems_()};
    var user = verifySession_(session, true);
    if (!user) return {ready: true, authenticated: false};
    if(identityOnly===true&&!address)return {ready:true,authenticated:true,name:user.name,role:user.role};
    if (address) assertAddress_(address);
    var folder = address ? addressFolder_(address, false) : null;
    var resources = folder ? photoFiles_(folder) : [];
    return {ready: true, authenticated: true, name: user.name, role: user.role,
      totalCount: resources.length,
      photos: resources.filter(function(f) { return canSeePhoto_(user, f); }).map(publicPhoto_), quota: quota_(),
      maxBytes: PHOTO_LIMITS_.maxBytes, maxPhotos: PHOTO_LIMITS_.slots};
  });
}

function loginPhoto(name, password) {
  return rpc_(function() {
    requireConfig_();
    return withLease_('login-guard',function(){
    name = normalizeLogin_(name);
    var now = Date.now(), props = PropertiesService.getScriptProperties();
    var guard = JSON.parse(props.getProperty('LOGIN_GUARD') || '{}');
    if (Number(guard.lockedUntil || 0) > now)
      fail_('RATE_LIMIT', '로그인 실패가 누적되어 잠시 잠겼습니다. 10분 후 다시 시도하세요.');
    if (!guard.startedAt || now - guard.startedAt >= 600000) guard = {startedAt: now, failures: 0};
    var cache = CacheService.getScriptCache();
    var bucket = 'login:' + digest_(name.toLowerCase());
    var tries = Number(cache.get(bucket) || 0);
    if (tries >= 8) fail_('RATE_LIMIT', '로그인 시도가 많습니다. 잠시 후 다시 시도하세요.');
    var actor = authenticateActor_(name, password);
    if (!actor) {
      cache.put(bucket, String(tries + 1), 600);
      guard.failures++;
      if (guard.failures >= 20) guard.lockedUntil = now + 600000;
      props.setProperty('LOGIN_GUARD', JSON.stringify(guard));
      fail_('LOGIN', '아이디 또는 개인 접속코드를 확인하세요.');
    }
    cache.remove(bucket);
    ensureAuthKey_();
    var payload = Utilities.base64EncodeWebSafe(JSON.stringify({v: 3, login: actor.login, sub: actor.id,
      role: actor.role, cv: actor.version,
      exp: Date.now() + PHOTO_LIMITS_.sessionHours * 3600000,
      nonce: Utilities.getUuid()}), Utilities.Charset.UTF_8);
    return {session: payload + '.' + sign_(payload), name: actor.name, role: actor.role};
    });
  });
}

function uploadPhoto(session, address, photo) {
  return rpc_(function() {
    var actor=verifySession_(session);
    if(PHOTO_LIMITS_.publicEnabled===true&&(!photo||photo.publicShare!==true))fail_('PUBLIC_CONSENT','이전 사진 화면에서는 등록할 수 없습니다. 새 공개 안내 화면을 다시 여세요.');
    if(PHOTO_LIMITS_.requireCapture)fail_('CAPTURE','지도 사이트의 새 촬영 화면에서 직접 촬영해 주세요.');
    return uploadForActor_(actor,address,photo);
  });
}
function uploadForActor_(user,address,photo) {
    assertAddress_(address);
    if (!photo || photo.confirmReadable !== true) fail_('PREVIEW', '날짜와 현장이 잘 보이는지 미리보기를 확인해 주세요.');
    var visitDate = String(photo.visitDate || '');
    if (!validDate_(visitDate)) fail_('DATE', '올바른 방문일을 입력하세요.');
    var bytes = decodePhoto_(photo.base64);
    var hash = digest_(bytes);
    // Only this address is exclusive. Other addresses can upload while MYBOX responds.
    return withLease_('address:'+digest_(address),function(){
      var folder = addressFolder_(address, true);
      var files = photoFiles_(folder);
      var existing = files.filter(function(f) { return f.name.indexOf('__' + hash + '__') >= 0; })[0];
      // Network retries of an already-saved photo do not use the second slot.
      if (existing) {
        if (!canSeePhoto_(user, existing)) fail_('DUPLICATE', '동일한 사진은 이미 등록되어 있습니다. 관리자에게 확인해 주세요.');
        return {saved: true, alreadySaved: true, photo: publicPhoto_(existing), count: files.length,
          catalogPending: !tryCatalogUpdate_(address, files)};
      }
      if (files.length >= PHOTO_LIMITS_.slots) fail_('FULL', '이 주소에는 이미 사진 2장이 저장되어 있습니다.');
      if(photo.captureEvidence)saveEvidence_(address,hash,user,photo.captureEvidence);
      var quota = quota_();
      if (!quota.canUpload || quota.usedBytes + bytes.length > quota.stopAtBytes)
        fail_('STORAGE', '무료 운영 안전 한도에 도달했습니다. 용량을 확인한 후 다시 시도하세요.');
      markCatalogPending_(address);
      var slot = files.some(function(f) { return /^1__/.test(f.name); }) ? 2 : 1;
      var timestamp = new Date().toISOString();
      var filename = slot + '__' + hash + '__' + timestamp.replace(/[-:.]/g, '') +
        '__' + visitDate + '__' + (user.role==='device'?'v4d-':'v3u-') + user.id + '__' + user.name.replace(/[^\p{L}\p{N} ._-]/gu, '_') + '.jpg';
      var target = api_('/drive/files', 'post', {parentId: folder, fileName: filename,
        fileSize: bytes.length, isOverwrite: false});
      var url = storageUrl_(target.uploadUrl, 'upload');
      var response = fetch_(url, {method: 'post', followRedirects: false,
        muteHttpExceptions: true, payload: {Filedata: Utilities.newBlob(bytes, 'image/jpeg', filename)}});
      if (response.getResponseCode() < 200 || response.getResponseCode() >= 300)
        fail_('UPLOAD', 'MYBOX가 저장을 완료하지 못했습니다. 새로고침 후 저장 여부를 확인하세요.');
      // Treat storage's HTTP response as provisional: re-list and verify the exact name/size.
      var after = photoFiles_(folder);
      var saved = after.filter(function(f) { return f.name === filename && Number(f.size) === bytes.length; })[0];
      if (!saved) fail_('VERIFY', '저장 응답을 받았지만 파일 확인이 지연됩니다. 새로고침 후 확인하세요.');
      return {saved: true, alreadySaved: false, photo: publicPhoto_(saved), count: after.length,
        catalogPending: !tryCatalogUpdate_(address, after)};
    });
}

function getPhoto(session, address, slot) {
  return rpc_(function() {
    var user = verifySession_(session);
    assertAddress_(address);
    slot = Number(slot);
    if (slot !== 1 && slot !== 2) fail_('SLOT', '사진 번호가 올바르지 않습니다.');
    var folder = addressFolder_(address, false);
    var file = folder && photoFiles_(folder).filter(function(f) { return Number(f.name[0]) === slot; })[0];
    if (!file) fail_('NOT_FOUND', '저장된 사진이 없습니다.');
    if (!canSeePhoto_(user, file)) fail_('FORBIDDEN', '본인이 등록한 사진만 볼 수 있습니다.');
    if (Number(file.size) > PHOTO_LIMITS_.maxBytes) fail_('SIZE', '허용된 사진 크기를 초과했습니다.');
    var target = api_('/drive/files/' + encodeURIComponent(file.resourceId) + '/download');
    var response = fetch_(storageUrl_(target.downloadUrl, 'download'),
      {muteHttpExceptions: true, followRedirects: false});
    if (response.getResponseCode() !== 200) fail_('DOWNLOAD', '사진을 불러오지 못했습니다. 잠시 후 다시 시도하세요.');
    var bytes = response.getContent();
    assertJpeg_(bytes);
    var p=publicPhoto_(file);if(user.role==='admin')p.evidence=evidenceFor_(address,file);
    return {base64: Utilities.base64Encode(bytes), photo: p};
  });
}

var PHOTO_STAGE_ = '';
function rpc_(fn) {
  try {
    PHOTO_STAGE_='start';
    PHOTO_INDEX_CONTEXT_ = null; PHOTO_SOURCE_ = null; PHOTO_SOURCE_INDEX_ = null;
    return {ok: true, data: fn()};
  }
  catch (error) {
    console.warn(JSON.stringify({event:'photo_request_failed',code:error.photoCode||'SERVICE',stage:PHOTO_STAGE_||'unknown'}));
    // Never forward raw network errors: they can contain PATs or signed storage URLs.
    return {ok: false, code: error.photoCode || 'SERVICE', message: error.photoCode ? error.message :
      '서비스 연결 또는 무료 사용 한도 문제가 발생했습니다. 잠시 후 다시 시도하거나 관리자에게 알려주세요.'};
  } finally { PHOTO_INDEX_CONTEXT_ = null; PHOTO_SOURCE_ = null; PHOTO_SOURCE_INDEX_ = null; }
}
// LockService is held only for the atomic lease-property change, never for network I/O.
function withScriptLock_(fn) {
  var lock=LockService.getScriptLock();
  if(!lock.tryLock(5000))fail_('BUSY','잠시 후 다시 시도하세요.');
  try{return fn();}finally{lock.releaseLock();}
}
function withLease_(scope,fn) {
  var key='PHOTO_LEASE_'+digest_(scope),token=Utilities.getUuid(),props=PropertiesService.getScriptProperties();
  withScriptLock_(function(){
    var current=JSON.parse(props.getProperty(key)||'null');
    if(current&&Number(current.until)>Date.now())fail_('BUSY','이 주소의 저장 작업이 진행 중입니다. 잠시 후 다시 시도하세요.');
    // Apps Script executions stop at six minutes; the lease then expires automatically.
    props.setProperty(key,JSON.stringify({token:token,until:Date.now()+390000}));
  });
  try{return fn();}finally{
    try{withScriptLock_(function(){
      var current=JSON.parse(props.getProperty(key)||'null');
      if(current&&current.token===token)props.deleteProperty(key);
    });}catch(error){
      // A completed MYBOX write must not be reported as failed solely because
      // lease cleanup missed its brief lock window. The TTL remains the backstop.
      console.warn(JSON.stringify({event:'photo_lease_cleanup_delayed',scope:digest_(scope).slice(0,8)}));
    }
  }
}
function fetch_(url, options) { return UrlFetchApp.fetch(url, options); }
function fail_(code, message) { var e = new Error(message); e.photoCode = code; throw e; }
function secret_(key) { return String(PropertiesService.getScriptProperties().getProperty(key) || '').trim(); }
function setupProblems_() {
  var out = [], size = secret_('PHOTO_ADMIN_PASSWORD').length;
  if (secret_('MYBOX_TOKEN').length < 24) out.push('MYBOX_TOKEN 등록을 확인해 주세요.');
  if (size < 8 || size > 200) out.push('관리자가 PHOTO_ADMIN_PASSWORD를 8~200자로 등록해야 합니다. 기존 팀 암호는 사용할 수 없습니다.');
  if (size && secret_('PHOTO_TEAM_PASSWORD') && equal_(secret_('PHOTO_ADMIN_PASSWORD'), secret_('PHOTO_TEAM_PASSWORD')))
    out.push('관리자 암호는 직원에게 공유했던 기존 팀 암호와 다르게 설정해 주세요.');
  return out;
}
function configured_() { return setupProblems_().length === 0; }
function requireConfig_() { var issues=setupProblems_(); if (issues.length) fail_('SETUP', issues.join(' ')); }
function sign_(payload) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature('photo-rbac-v3\n' + payload,
    secret_('PHOTO_AUTH_KEY_V3') || 'uninitialized-no-valid-sessions', Utilities.Charset.UTF_8));
}
function verifySession_(token, optional) {
  requireConfig_();
  var parts = String(token || '').split('.');
  if (parts.length === 2 && parts[0].length < 1000 && equal_(sign_(parts[0]), parts[1])) {
    try {
      var claims = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString('UTF-8'));
      var user = claims.v === 3 && secret_('PHOTO_AUTH_KEY_V3') && actorForLogin_(claims.login);
      if (user && user.id === claims.sub && user.role === claims.role && user.version === claims.cv && Number.isFinite(claims.exp) &&
          claims.exp > Date.now() && claims.exp <= Date.now() + PHOTO_LIMITS_.sessionHours * 3600000) return user;
    } catch (ignored) {}
  }
  if (optional) return null;
  fail_('AUTH', '로그인이 만료되었습니다. 다시 로그인하세요.');
}
function equal_(a, b) {
  var delta = a.length ^ b.length;
  for (var i = 0; i < Math.max(a.length, b.length); i++) delta |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return delta === 0;
}
function digest_(value) {
  var bytes = typeof value === 'string' ? Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8) :
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value);
  return bytes.map(function(b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}
function validDate_(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  var date = new Date(value + 'T12:00:00Z');
  return !isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value &&
    value >= '2000-01-01' && value <= Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
}
function decodePhoto_(base64) {
  if (typeof base64 !== 'string' || base64.length > Math.ceil(PHOTO_LIMITS_.maxBytes / 3) * 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) fail_('SIZE', '사진은 자동 압축된 200KB 이하 JPEG만 저장할 수 있습니다.');
  var bytes;
  try { bytes = Utilities.base64Decode(base64); } catch (e) { fail_('JPEG', '사진 파일을 읽지 못했습니다.'); }
  assertJpeg_(bytes);
  return bytes;
}
function assertJpeg_(signed) {
  if (!signed || signed.length < 32 || signed.length > PHOTO_LIMITS_.maxBytes) fail_('SIZE', '사진 크기는 200KB 이하여야 합니다.');
  var b = signed.map(function(v) { return v & 255; });
  if (b[0] !== 255 || b[1] !== 216 || b[b.length - 2] !== 255 || b[b.length - 1] !== 217)
    fail_('JPEG', '올바른 JPEG 사진이 아닙니다.');
  var offset = 2, dimensions = false;
  while (offset < b.length - 2) {
    if (b[offset++] !== 255) fail_('JPEG', 'JPEG 사진 구조를 확인하지 못했습니다.');
    while (b[offset] === 255) offset++;
    var marker = b[offset++];
    if (marker === 218) break;
    var length = (b[offset] << 8) | b[offset + 1];
    if (length < 2 || offset + length > b.length - 2) fail_('JPEG', '손상된 JPEG 사진입니다.');
    if (marker === 192 || marker === 194) {
      if (length < 8) fail_('JPEG', '손상된 JPEG 크기 정보입니다.');
      var h = (b[offset + 3] << 8) | b[offset + 4], w = (b[offset + 5] << 8) | b[offset + 6];
      if (w < 1 || h < 1 || Math.max(w, h) > PHOTO_LIMITS_.maxEdge) fail_('DIMENSIONS', '사진의 긴 변은 1600px 이하여야 합니다.');
      dimensions = true;
    }
    // Canvas can retain a small ICC color profile. It is not GPS/EXIF metadata.
    var icc = marker === 226 && length <= 4096 &&
      String.fromCharCode.apply(null, b.slice(offset + 2, offset + 14)) === 'ICC_PROFILE\x00';
    // Reject EXIF/IPTC/comment bypasses. Allow the browser's color profile only.
    if (!icc && (marker >= 225 && marker <= 237 || marker === 239 || marker === 254))
      fail_('METADATA', '개인정보 메타데이터가 포함되어 있습니다. 사진을 다시 선택해 압축하세요.');
    offset += length;
  }
  if (!dimensions) fail_('JPEG', 'JPEG 사진의 크기 정보를 찾지 못했습니다.');
}
function assertAddress_(address) {
  if (typeof address !== 'string' || !address || address.length > 1000) fail_('ADDRESS', '사이트에서 주소를 다시 선택하세요.');
  var cache = CacheService.getScriptCache(), key = 'address-v5:' + digest_(address);
  var cached = cache.get(key);
  if (cached) return JSON.parse(cached);
  var info = sourceAddressIndex_()[address];
  if (!info) fail_('ADDRESS', '원자료에 없는 주소입니다. 지도에서 주소를 다시 선택하세요.');
  cache.put(key, JSON.stringify(info), 21600);
  return info;
}
var PHOTO_SOURCE_ = null;
var PHOTO_SOURCE_INDEX_ = null;
function sourceAddressIndex_() {
  if(PHOTO_SOURCE_INDEX_)return PHOTO_SOURCE_INDEX_;
  var data=sourceData_(),index=Object.create(null);
  Object.keys(data).forEach(function(s){Object.keys(data[s]).forEach(function(g){Object.keys(data[s][g]).forEach(function(d){data[s][g][d].forEach(function(p){
    var address=p[2];
    if(typeof address!=='string'||!address||address.length>1000||Object.prototype.hasOwnProperty.call(index,address))fail_('SOURCE','원주소 목록의 형식이나 중복을 확인해야 합니다.');
    index[address]={province:s,district:g,dong:d,latitude:p[0],longitude:p[1],coordinateVerified:!!p[4]};
  });});});});
  PHOTO_SOURCE_INDEX_=index;return index;
}
function sourceData_() {
  if (PHOTO_SOURCE_) return PHOTO_SOURCE_;
  var response = fetch_(PHOTO_LIMITS_.sourceUrl, {muteHttpExceptions: true, followRedirects: false});
  if (response.getResponseCode() !== 200) fail_('SOURCE', '원주소 목록을 확인할 수 없습니다. 잠시 후 다시 시도하세요.');
  var source = response.getContentText('UTF-8').trim();
  var prefix = 'window.ADDR_DATA = ';
  if (source.indexOf(prefix) !== 0) fail_('SOURCE', '원주소 데이터 형식이 달라 확인이 필요합니다.');
  var data;
  try { data = JSON.parse(source.slice(prefix.length).replace(/;\s*$/, '')); }
  catch (e) { fail_('SOURCE', '원주소 데이터를 읽지 못했습니다.'); }
  PHOTO_SOURCE_ = data; return data;
}
function api_(path, method, body) {
  requireConfig_();
  PHOTO_STAGE_=String(method||'get').toUpperCase()+' '+path.split('?')[0].replace(/\/(folders|files|resources)\/[^/]+/g,'/$1/:id');
  var options = {method: method || 'get', headers: {Authorization: 'Bearer ' + secret_('MYBOX_TOKEN')},
    followRedirects: false, muteHttpExceptions: true};
  if (body) { options.contentType = 'application/json'; options.payload = JSON.stringify(body); }
  var response = fetch_('https://open-api.mybox.naver.com/v1' + path, options);
  var status = response.getResponseCode();
  if(status<200||status>=300)console.warn(JSON.stringify({event:'mybox_http_error',http:status,stage:PHOTO_STAGE_}));
  if (status === 401 || status === 403) fail_('MYBOX_AUTH', 'MYBOX 인증키가 만료되었거나 접근이 제한됐습니다. 관리자에게 알려주세요.');
  if (status === 429) fail_('RATE_LIMIT', 'MYBOX 사용 한도에 도달했습니다. 잠시 후 다시 시도하세요.');
  if (status === 507) fail_('STORAGE', 'MYBOX 저장 공간이 부족합니다.');
  if (status < 200 || status >= 300) fail_('MYBOX', 'MYBOX 요청을 완료하지 못했습니다. 잠시 후 다시 시도하세요.');
  if (status === 204) return {};
  try { return JSON.parse(response.getContentText()); }
  catch (e) { fail_('MYBOX', 'MYBOX 응답을 확인하지 못했습니다.'); }
}
function storageUrl_(value, operation) {
  // Only MYBOX itself supplies these URLs; never accept a URL from an RPC argument.
  if (typeof value !== 'string' || value.length > 2000 ||
      !/^https:\/\/[A-Za-z0-9.-]+(?::443)?\/v1\/storage\/(upload|download)\?/.test(value) ||
      value.indexOf('/v1/storage/' + operation + '?') < 0)
    fail_('STORAGE_URL', 'MYBOX 저장 서버 주소를 확인하지 못했습니다.');
  return value;
}
function quota_() {
  var storage = api_('/drive/storage');
  var total = Number(storage.quotaBytes), used = Number(storage.usedBytes);
  if (!Number.isFinite(total) || !Number.isFinite(used) || total < 1 || used < 0)
    fail_('QUOTA', '남은 저장 공간을 확인하지 못해 업로드를 중단했습니다.');
  var stopAt = Math.max(0, Math.min(PHOTO_LIMITS_.accountCeilingBytes, total - PHOTO_LIMITS_.reserveBytes));
  return {totalBytes: total, usedBytes: used, stopAtBytes: stopAt,
    remainingSafeBytes: Math.max(0, stopAt - used), canUpload: used + PHOTO_LIMITS_.maxBytes <= stopAt};
}
function listResources_(parent) {
  var out = [], cursor = '';
  for (var page = 0; page < 100; page++) {
    var path = parent ? '/drive/folders/' + encodeURIComponent(parent) + '/resources' : '/drive/resources';
    var result = api_(path + '?count=1000' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    if (!Array.isArray(result.resources)) fail_('FILES', 'MYBOX 파일 목록을 확인하지 못했습니다.');
    out = out.concat(result.resources);
    cursor = result.responseMetaData && result.responseMetaData.nextCursor;
    if (!cursor) return out;
  }
  fail_('FILES', '폴더 내 항목이 너무 많아 안전하게 확인할 수 없습니다.');
}
function folder_(parent, name, create) {
  var matches = listResources_(parent).filter(function(r) { return r.name === name; });
  if (matches.length > 1 || matches.length === 1 && matches[0].type !== 'folder')
    fail_('FOLDER', '같은 이름의 항목이 있어 안전하게 저장할 수 없습니다. 관리자에게 알려주세요.');
  if (matches.length) return matches[0].resourceId;
  if (!create) return null;
  return withLease_('folder:'+parent+'\n'+name,function(){
    var again=listResources_(parent).filter(function(r){return r.name===name;});
    if(again.length>1||again.length===1&&again[0].type!=='folder')fail_('FOLDER','같은 이름의 항목이 있어 안전하게 저장할 수 없습니다.');
    if(again.length)return again[0].resourceId;
    var body={folderName:name};if(parent)body.parentId=parent;
    var result=api_('/drive/folders','post',body);
    if(!result.resourceId)fail_('FOLDER','사진 폴더를 만들지 못했습니다.');
    return result.resourceId;
  });
}
function addressFolder_(address, create) {
  var root = folder_('', PHOTO_LIMITS_.rootName, create);
  if (!root) return null;
  var id = digest_(address), shard = folder_(root, id.slice(0, 2), create);
  if (!shard) return null;
  var label = address.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 70);
  return folder_(shard, id + '__' + label, create);
}
function photoFiles_(folder) {
  var files = listResources_(folder);
  if (files.length > 2 || files.some(function(f) { return f.type !== 'file' ||
      !/^[12]__[0-9a-f]{64}__\d{8}T\d{9}Z__\d{4}-\d{2}-\d{2}__.+\.jpg$/.test(f.name); }))
    fail_('MANUAL_CHANGE', '사진 폴더가 앱 밖에서 변경됐습니다. 관리자 확인 전 업로드를 중단합니다.');
  if (new Set(files.map(function(f) { return f.name[0]; })).size !== files.length)
    fail_('SLOT_CONFLICT', '같은 번호의 사진이 중복되어 관리자 확인이 필요합니다.');
  return files.sort(function(a, b) { return a.name.localeCompare(b.name); });
}
function photoId_(file){return digest_(String(file.resourceId)+'\n'+file.name);}
function publicPhoto_(file) {
  var parts = file.name.split('__');
  var encodedTime=parts[2]||'',serverTime=encodedTime.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/,'$1-$2-$3T$4:$5:$6.$7Z');
  return {id:photoId_(file),slot: Number(parts[0]), visitDate: parts[3], uploader: parts.slice(photoOwner_(file) ? 5 : 4).join('__').replace(/\.jpg$/, ''),
    legacy: !photoOwner_(file),
    uploadedAt: isNaN(Date.parse(serverTime)) ? (file.createdAt || file.createdTime || null) : serverTime, bytes: Number(file.size)};
}
