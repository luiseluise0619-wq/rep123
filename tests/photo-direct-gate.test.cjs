const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const handler=require('../web/api/photo-direct.js');
const {createService}=require('../web/api/_lib/photo-direct-core.cjs');

function response(){let code=200,payload,headers={};return {
  setHeader:(key,value)=>{headers[key]=value;},
  status(value){code=value;return this;},json(value){payload=value;return this;},
  result(){return {code,payload,headers};}
};}

test('direct API stays closed until separately enabled on Vercel',async()=>{
  const previous=process.env.PHOTO_DIRECT_ENABLED;delete process.env.PHOTO_DIRECT_ENABLED;
  try{const res=response();await handler({method:'POST',body:{action:'status',address:'anything'}},res);
    assert.equal(res.result().code,503);assert.equal(res.result().payload.code,'NOT_READY');
    assert.equal(res.result().headers['Cache-Control'],'no-store');}
  finally{if(previous===undefined)delete process.env.PHOTO_DIRECT_ENABLED;else process.env.PHOTO_DIRECT_ENABLED=previous;}
});

test('direct API rejects all actions when the administrator credential is not ready',async()=>{
  const enabled=process.env.PHOTO_DIRECT_ENABLED,password=process.env.PHOTO_ADMIN_PASSWORD;
  process.env.PHOTO_DIRECT_ENABLED='true';process.env.PHOTO_ADMIN_PASSWORD='short7!';
  try{const res=response();await handler({method:'POST',body:{action:'status',address:'anything'}},res);
    assert.equal(res.result().code,503);assert.equal(res.result().payload.code,'SETUP');}
  finally{
    if(enabled===undefined)delete process.env.PHOTO_DIRECT_ENABLED;else process.env.PHOTO_DIRECT_ENABLED=enabled;
    if(password===undefined)delete process.env.PHOTO_ADMIN_PASSWORD;else process.env.PHOTO_ADMIN_PASSWORD=password;
  }
});

test('eight-character administrator password is accepted',()=>{
  const service=createService({token:'test-token',adminPassword:'eight123'});
  assert.ok(service.adminLogin('eight123').session);
  assert.throws(()=>service.adminLogin('wrong-one'),{code:'LOGIN'});
});

test('new admin page parses without inline secrets and retains public-photo consent path',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../web/photo-admin.html'),'utf8');
  const script=html.match(/<script>([\s\S]*?)<\/script>/)?.[1];assert.ok(script);
  assert.doesNotThrow(()=>new vm.Script(script));
  assert.match(script,/adminLogin/);assert.match(script,/adminOverview/);assert.match(script,/photoDirectAdminSession/);
  assert.doesNotMatch(script,/MYBOX_TOKEN|PHOTO_ADMIN_PASSWORD/);
  const config=fs.readFileSync(path.join(__dirname,'../web/photo-config.js'),'utf8');
  assert.doesNotMatch(config,/webAppUrl|directEnabled|script\.google\.com\/macros/);
});
