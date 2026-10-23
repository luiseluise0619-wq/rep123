// Production direct-upload control plane. Disabled until the Vercel environment
// is configured and the staging/locking workflow passes live MYBOX validation.
const {createService,error}=require('./_lib/photo-direct-core.cjs');
const {createVisitService}=require('./_lib/visit-result-core.cjs');

module.exports=async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Content-Type-Options','nosniff');
  if(req.method!=='POST')return res.status(405).json({ok:false,code:'METHOD'});
  if(process.env.PHOTO_DIRECT_ENABLED!=='true')
    return res.status(503).json({ok:false,code:'NOT_READY',message:'직접 전송은 아직 점검 중입니다. 기존 사진 화면을 이용해 주세요.'});
  if(typeof process.env.PHOTO_ADMIN_PASSWORD!=='string'||process.env.PHOTO_ADMIN_PASSWORD.length<8)
    return res.status(503).json({ok:false,code:'SETUP',message:'사진 관리 설정을 확인해야 합니다.'});
  if(Number(req.headers['content-length']||0)>25000)
    return res.status(413).json({ok:false,code:'SIZE',message:'요청 내용이 너무 큽니다.'});
  try{
    const body=typeof req.body==='string'?JSON.parse(req.body):req.body||{};
    if(!body||typeof body!=='object'||Array.isArray(body))throw error('INPUT',400,'요청 형식이 올바르지 않습니다.');
    const service=createService({token:process.env.MYBOX_TOKEN,adminPassword:process.env.PHOTO_ADMIN_PASSWORD});
    const visits=createVisitService(service);
    let data;
    switch(body.action){
      case 'status':data=await service.status(body.address,body.deviceKey);break;
      case 'capture':data=await service.capture(body.address,body.deviceKey);break;
      case 'receipt':data=await service.receipt(body.address,body.deviceKey,body.hash);break;
      case 'reserve':data=await service.reserve(body);break;
      case 'finish':data=await service.finish(body);break;
      case 'photo':data=await service.publicPhoto(body.address,body.photoId);break;
      case 'remove':{
        const admin=!!body.adminSession;if(admin)service.requireAdmin(body.adminSession);
        data=await service.remove({...body,admin});break;
      }
      case 'completionMeta':data=await service.completionMeta();break;
      case 'completionChunk':data=await service.completionChunk(body.key);break;
      case 'adminLogin':data=service.adminLogin(body.password);break;
      case 'adminOverview':service.requireAdmin(body.adminSession);data=await service.overview();break;
      case 'adminChunk':service.requireAdmin(body.adminSession);data=await service.chunk(body.key);break;
      case 'repairPending':service.requireAdmin(body.adminSession);data=await service.repairPending(10);break;
      case 'visitStatus':data=await visits.status(body.address,body.deviceKey);break;
      case 'visitSave':data=await visits.save(body);break;
      case 'visitMeta':service.requireAdmin(body.adminSession);data=await visits.meta();break;
      case 'visitChunk':service.requireAdmin(body.adminSession);data=await visits.chunk(body.key);break;
      case 'visitArchive':service.requireAdmin(body.adminSession);data=await visits.archive();break;
      case 'visitRollup':service.requireAdmin(body.adminSession);data=await visits.rollup();break;
      default:throw error('INPUT',400,'요청 종류가 올바르지 않습니다.');
    }
    return res.status(200).json({ok:true,data});
  }catch(e){
    console.warn(JSON.stringify({event:'photo_direct_request_failed',code:e.code||'SERVICE',status:e.status||500}));
    return res.status(e.status||500).json({ok:false,code:e.code||'SERVICE',
      message:e.code?e.message:'사진 저장 연결에 문제가 있습니다. 잠시 후 다시 시도해 주세요.'});
  }
};
