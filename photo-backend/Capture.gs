/** Device-reported location is private admin evidence, never proof of physical presence. */
function beginPublicCapture(deviceKey,address,location){
  return rpc_(function(){requirePublic_();var actor=deviceActor_(deviceKey,true),where=assertAddress_(address),now=Date.now();
    if(!location||!Number.isFinite(location.latitude)||location.latitude < -90||location.latitude>90||
       !Number.isFinite(location.longitude)||location.longitude < -180||location.longitude>180||
       !Number.isFinite(location.accuracy)||location.accuracy<=0||location.accuracy>10000||
       !Number.isFinite(location.timestamp)||Math.abs(now-location.timestamp)>120000)
      fail_('LOCATION','현재 위치를 다시 확인해 주세요. 기기 시계도 확인하세요.');
    ensureAuthKey_();
    var value={kind:'live-camera-v1',actor:actor.id,address:address,issuedAt:now,expiresAt:now+600000,nonce:Utilities.getUuid(),
      latitude:location.latitude,longitude:location.longitude,accuracy:location.accuracy,positionAt:location.timestamp,
      destination:{latitude:where.latitude,longitude:where.longitude,coordinateVerified:!!where.coordinateVerified}};
    var payload=Utilities.base64EncodeWebSafe(JSON.stringify(value),Utilities.Charset.UTF_8);
    return {ticket:payload+'.'+authMac_('capture-v1\n'+payload),expiresAt:value.expiresAt};
  });
}
function verifyCapture_(ticket,actor,address,capturedAt){
  var parts=String(ticket||'').split('.'),value,now=Date.now();
  if(parts.length!==2||parts[0].length>3000||!secret_('PHOTO_AUTH_KEY_V3')||!equal_(authMac_('capture-v1\n'+parts[0]),parts[1]))
    fail_('CAPTURE','새 촬영 화면에서 위치 확인 후 사진을 찍어 주세요.');
  try{value=JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString('UTF-8'));}catch(ignored){fail_('CAPTURE','촬영 정보를 확인하지 못했습니다.');}
  if(value.kind!=='live-camera-v1'||value.actor!==actor.id||value.address!==address||!Number.isFinite(value.expiresAt)||
     value.expiresAt<now||value.issuedAt>now+30000||!Number.isFinite(capturedAt)||capturedAt<value.issuedAt-30000||
     capturedAt>now+30000||now-capturedAt>600000)fail_('CAPTURE','촬영 정보가 만료되었거나 주소가 바뀌었습니다. 위치 확인 후 다시 촬영하세요.');
  return {source:'device-reported-live-camera',latitude:value.latitude,longitude:value.longitude,accuracy:value.accuracy,
    positionAt:new Date(value.positionAt).toISOString(),capturedAt:new Date(capturedAt).toISOString(),
    receivedAt:new Date(now).toISOString(),destination:value.destination,
    distanceMeters:PHOTO_DISTANCE_.metres(value,value.destination),distanceMethod:'haversine-map-coordinate',proofOfVisit:false};
}
function evidenceShard_(key){
  var value=indexRead_('evidence-'+key+'.json',{v:1,rows:{}});
  if(!value||value.v!==1||!value.rows||Array.isArray(value.rows)||typeof value.rows!=='object')fail_('EVIDENCE','위치 기록 파일을 확인해야 합니다.');
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
