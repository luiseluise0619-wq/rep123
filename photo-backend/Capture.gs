/** Signed camera timestamps. Location collection is disabled in production; old records are preserved. */
function beginPublicCapture(deviceKey,address,location){
  return rpc_(function(){requirePublic_();var actor=deviceActor_(deviceKey,true),where=assertAddress_(address),now=Date.now();
    if(PHOTO_LIMITS_.requireLocation===true&&(!location||!Number.isFinite(location.latitude)||location.latitude < -90||location.latitude>90||
       !Number.isFinite(location.longitude)||location.longitude < -180||location.longitude>180||
       !Number.isFinite(location.accuracy)||location.accuracy<=0||location.accuracy>10000||
       !Number.isFinite(location.timestamp)||Math.abs(now-location.timestamp)>120000))
      fail_('LOCATION','현재 위치를 다시 확인해 주세요. 기기 시계도 확인하세요.');
    ensureAuthKey_();
    var value={kind:PHOTO_LIMITS_.requireLocation===true?'live-camera-v1':'camera-only-v1',actor:actor.id,address:address,issuedAt:now,expiresAt:now+600000,nonce:Utilities.getUuid()};
    if(PHOTO_LIMITS_.requireLocation===true){value.latitude=location.latitude;value.longitude=location.longitude;value.accuracy=location.accuracy;value.positionAt=location.timestamp;
      value.destination={latitude:where.latitude,longitude:where.longitude,coordinateVerified:!!where.coordinateVerified};}
    var payload=Utilities.base64EncodeWebSafe(JSON.stringify(value),Utilities.Charset.UTF_8);
    return {ticket:payload+'.'+authMac_('capture-v1\n'+payload),expiresAt:value.expiresAt};
  });
}
function verifyCapture_(ticket,actor,address,capturedAt){
  var parts=String(ticket||'').split('.'),value,now=Date.now();
  if(parts.length!==2||parts[0].length>3000||!secret_('PHOTO_AUTH_KEY_V3')||!equal_(authMac_('capture-v1\n'+parts[0]),parts[1]))
    fail_('CAPTURE','새 촬영 화면에서 직접 사진을 찍어 주세요.');
  try{value=JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString('UTF-8'));}catch(ignored){fail_('CAPTURE','촬영 정보를 확인하지 못했습니다.');}
  var validKind=PHOTO_LIMITS_.requireLocation===true?value.kind==='live-camera-v1':value.kind==='camera-only-v1'||value.kind==='live-camera-v1';
  if(!validKind||value.actor!==actor.id||value.address!==address||!Number.isFinite(value.expiresAt)||
     value.expiresAt<now||value.issuedAt>now+30000||!Number.isFinite(capturedAt)||capturedAt<value.issuedAt-30000||
     capturedAt>now+30000||now-capturedAt>600000)fail_('CAPTURE','촬영 정보가 만료되었거나 주소가 바뀌었습니다. 다시 촬영해 주세요.');
  // Also discard GPS in previously issued, valid tickets after location collection is switched off.
  if(PHOTO_LIMITS_.requireLocation!==true)return {source:'live-camera-no-location',locationCollected:false,
    capturedAt:new Date(capturedAt).toISOString(),receivedAt:new Date(now).toISOString(),proofOfVisit:false};
  return {source:'device-reported-live-camera',latitude:value.latitude,longitude:value.longitude,accuracy:value.accuracy,
    positionAt:new Date(value.positionAt).toISOString(),capturedAt:new Date(capturedAt).toISOString(),
    receivedAt:new Date(now).toISOString(),destination:value.destination,
    distanceMeters:PHOTO_DISTANCE_.metres(value,value.destination),distanceMethod:'haversine-map-coordinate',proofOfVisit:false};
}
function evidenceShard_(key){
  var value=indexRead_('evidence-'+key+'.json',{v:1,rows:{}});
  if(!value||value.v!==1||!value.rows||Array.isArray(value.rows)||typeof value.rows!=='object')fail_('EVIDENCE','촬영 기록 파일을 확인해야 합니다.');
  return value;
}
function saveEvidence_(address,imageHash,actor,evidence){
  var key=digest_(address+'\n'+imageHash),shard=evidenceShard_(key[0]);
  shard.rows[key]={address:address,imageHash:imageHash,ownerId:actor.id,evidence:evidence};
  indexWrite_('evidence-'+key[0]+'.json',shard);
}
function evidenceFor_(address,file){
  var hash=file.name.split('__')[1],key=digest_(address+'\n'+hash),entry=evidenceShard_(key[0]).rows[key];
  if(!entry||entry.address!==address||entry.imageHash!==hash||entry.ownerId!==photoOwner_(file))return null;
  return entry.evidence;
}
