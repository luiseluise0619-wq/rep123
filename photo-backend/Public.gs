/** Public viewing/upload; the unguessable browser key authorizes deletion, not identity. */
function requirePublic_(){requireConfig_();if(PHOTO_LIMITS_.publicEnabled!==true)fail_('CLOSED','공개 사진 기능이 활성화되지 않았습니다.');}
function deviceActor_(key,required){
  if(typeof key!=='string'||!/^[0-9a-f]{64}$/.test(key)){if(required)fail_('DEVICE','이 브라우저의 삭제키를 저장할 수 없어 업로드할 수 없습니다.');return null;}
  return {id:digest_('photo-device-v4\n'+key).slice(0,32),role:'device',name:'현장등록'};
}
function publicEntry_(file,actor){
  var p=publicPhoto_(file);
  return {id:p.id,slot:p.slot,visitDate:p.visitDate,uploadedAt:p.uploadedAt,bytes:p.bytes,canDelete:!!actor&&canSeePhoto_(actor,file)};
}
function getPublicStatus(address,deviceKey){
  return rpc_(function(){requirePublic_();var actor=deviceActor_(deviceKey,false);if(address)assertAddress_(address);
    var folder=address?addressFolder_(address,false):null,files=folder?photoFiles_(folder):[],q=quota_();
    return {ready:true,totalCount:files.length,photos:files.map(function(f){return publicEntry_(f,actor);}),quota:{canUpload:q.canUpload}};
  });
}
function uploadPublicPhoto(deviceKey,address,photo){
  return rpc_(function(){requirePublic_();var actor=deviceActor_(deviceKey,true);
    if(!photo||photo.publicShare!==true)fail_('PUBLIC_CONSENT','누구나 볼 수 있는 공개 사진 등록 안내에 동의해 주세요.');
    assertAddress_(address);
    if(PHOTO_LIMITS_.requireCapture)photo.captureEvidence=verifyCapture_(photo.captureTicket,actor,address,photo.capturedAt);
    var value=uploadForActor_(actor,address,photo);
    // No filename, raw storage ID, owner hash or uploader name is returned to anonymous viewers.
    value.photo={id:value.photo.id,slot:value.photo.slot,visitDate:value.photo.visitDate,uploadedAt:value.photo.uploadedAt,bytes:value.photo.bytes,canDelete:true};
    return value;
  });
}
function publicFile_(address,photoId){
  assertAddress_(address);
  if(typeof photoId!=='string'||!/^[0-9a-f]{64}$/.test(photoId))fail_('PHOTO_ID','사진 식별자가 올바르지 않습니다.');
  var folder=addressFolder_(address,false),files=folder?photoFiles_(folder):[];
  return {folder:folder,files:files,file:files.filter(function(f){return photoId_(f)===photoId;})[0]};
}
function getPublicPhoto(address,photoId){
  return rpc_(function(){requirePublic_();var file=publicFile_(address,photoId).file;
    if(!file)fail_('NOT_FOUND','삭제되었거나 저장된 사진이 없습니다.');
    if(Number(file.size)>PHOTO_LIMITS_.maxBytes)fail_('SIZE','허용된 사진 크기를 초과했습니다.');
    var target=api_('/drive/files/'+encodeURIComponent(file.resourceId)+'/download');
    var response=fetch_(storageUrl_(target.downloadUrl,'download'),{muteHttpExceptions:true,followRedirects:false});
    if(response.getResponseCode()!==200)fail_('DOWNLOAD','사진을 불러오지 못했습니다.');
    var bytes=response.getContent();assertJpeg_(bytes);
    return {base64:Utilities.base64Encode(bytes),photo:publicEntry_(file,null)};
  });
}
function getPublicUploadReceipt(deviceKey,address,imageHash){
  return rpc_(function(){requirePublic_();var actor=deviceActor_(deviceKey,true);assertAddress_(address);
    if(typeof imageHash!=='string'||!/^[a-f0-9]{64}$/.test(imageHash))fail_('PHOTO_ID','사진 확인 번호가 올바르지 않습니다.');
    var folder=addressFolder_(address,false),files=folder?photoFiles_(folder):[];
    return {saved:files.some(function(file){return file.name.split('__')[1]===imageHash&&canSeePhoto_(actor,file);})};
  });
}
function deletePhoto(session,deviceKey,address,photoId){
  return rpc_(function(){requirePublic_();
    var admin=null;if(session){admin=verifySession_(session);if(admin.role!=='admin')fail_('FORBIDDEN','관리자 또는 사진을 올린 브라우저만 삭제할 수 있습니다.');}
    var actor=admin||deviceActor_(deviceKey,true);assertAddress_(address);
    return withLease_('address:'+digest_(address),function(){
    var target=publicFile_(address,photoId),file=target.file;
    if(!file)return {deleted:true,alreadyDeleted:true,catalogPending:pendingCatalog_().some(function(p){return p.address===address;})};
    if(!canSeePhoto_(actor,file))fail_('FORBIDDEN','관리자 또는 사진을 올린 브라우저만 삭제할 수 있습니다.');
    markCatalogPending_(address);
    // Only a verified JPEG inside this exact source-address folder can be moved to Trash.
    api_('/drive/resources/'+encodeURIComponent(file.resourceId),'delete');
    var after=photoFiles_(target.folder);
    if(after.some(function(f){return f.resourceId===file.resourceId;}))fail_('VERIFY','삭제 확인이 지연됩니다. 새로고침 후 확인하세요.');
    return {deleted:true,alreadyDeleted:false,catalogPending:!tryCatalogUpdate_(address,after)};
    });
  });
}
