/** Owner-run only. Explicitly authorized synthetic test, outside all field-photo folders. */
function diagnosePhotoStorage(session){
  return rpc_(function(){requireAdmin_(session);return diagnoseMyboxUpload_();});
}
function diagnoseMyboxUpload_(){
    requireConfig_();var folder=folder_('','연결점검_현장방문아님',true),bytes=Utilities.base64Decode(PHOTO_DIAG_JPEG_);
    var name='CONNECTION_TEST_NOT_A_FIELD_VISIT__'+Utilities.getUuid()+'.jpg';
    console.log(JSON.stringify({diagnostic:'folder_ready',bytes:bytes.length}));
    var target=api_('/drive/files','post',{parentId:folder,fileName:name,fileSize:bytes.length,isOverwrite:false});
    PHOTO_STAGE_='diagnostic_binary_upload';
    var response=fetch_(storageUrl_(target.uploadUrl,'upload'),{method:'post',followRedirects:false,muteHttpExceptions:true,payload:{Filedata:Utilities.newBlob(bytes,'image/jpeg',name)}});
    console.log(JSON.stringify({diagnostic:'binary_response',http:response.getResponseCode()}));
    var files=listResources_(folder),file=files.filter(function(f){return f.name===name&&Number(f.size)===bytes.length;})[0];
    if(!file)fail_('DIAGNOSTIC_UPLOAD','테스트 파일 저장을 확인하지 못했습니다.');
    var verified=false;
    try{var download=api_('/drive/files/'+encodeURIComponent(file.resourceId)+'/download');
      var stored=fetch_(storageUrl_(download.downloadUrl,'download'),{followRedirects:false,muteHttpExceptions:true});
      verified=stored.getResponseCode()===200&&digest_(stored.getContent())===digest_(bytes);
      console.log(JSON.stringify({diagnostic:'verified',saved:true,downloadMatches:verified}));
    }finally{api_('/drive/resources/'+encodeURIComponent(file.resourceId),'delete');}
    var remains=listResources_(folder).some(function(f){return f.resourceId===file.resourceId;});
    return {saved:true,readBackVerified:verified,movedToTrash:!remains,notAFieldVisit:true};
}
