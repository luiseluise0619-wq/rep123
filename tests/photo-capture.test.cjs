const test=require('node:test'),assert=require('node:assert/strict');
const {harness,fakeJpeg,ADDRESS}=require('./helpers/photo-harness.cjs');
const KEY='a'.repeat(64),OTHER='b'.repeat(64);
function sample(h,seed=1,key=KEY){const gps={latitude:37.599408,longitude:127.06618,accuracy:12,timestamp:Date.now()},permit=h.app.beginPublicCapture(key,ADDRESS,gps);assert.equal(permit.ok,true);return {base64:fakeJpeg(seed).toString('base64'),publicShare:true,confirmReadable:true,visitDate:'2026-10-16',captureTicket:permit.data.ticket,capturedAt:Date.now()};}
test('strict production capture rejects missing, invalid, stale or cross-device location permits',()=>{
 const h=harness({requireCapture:true}),photo=sample(h);
 assert.equal(h.app.PHOTO_LIMITS_.requireCapture,true);
 assert.equal(h.app.uploadPublicPhoto(KEY,ADDRESS,{...photo,captureTicket:''}).code,'CAPTURE');
 assert.equal(h.app.uploadPublicPhoto(OTHER,ADDRESS,photo).code,'CAPTURE');
 assert.equal(h.app.uploadPublicPhoto(KEY,ADDRESS,{...photo,capturedAt:Date.now()-700000}).code,'CAPTURE');
 assert.equal(h.app.uploadPhoto(h.session,ADDRESS,photo).code,'CAPTURE');
 assert.equal(h.app.beginPublicCapture(KEY,ADDRESS,{latitude:91,longitude:127,accuracy:10,timestamp:Date.now()}).code,'LOCATION');
 assert.equal(h.app.beginPublicCapture(KEY,ADDRESS,{latitude:37,longitude:127,accuracy:0,timestamp:Date.now()}).code,'LOCATION');
 assert.equal(h.app.beginPublicCapture(KEY,ADDRESS,{latitude:37,longitude:127,accuracy:10,timestamp:Date.now()-300000}).code,'LOCATION');
 const tampered=photo.captureTicket.slice(0,-1)+(photo.captureTicket.endsWith('a')?'b':'a');
 assert.equal(h.app.uploadPublicPhoto(KEY,ADDRESS,{...photo,captureTicket:tampered}).code,'CAPTURE');
 assert.equal(h.resources.filter(f=>f.name&&f.name.endsWith('.jpg')).length,0);
});
test('location and server registration time are private to admin and survive catalog re-scan',()=>{
 const h=harness({requireCapture:true}),photo=sample(h),uploaded=h.app.uploadPublicPhoto(KEY,ADDRESS,photo);
 assert.equal(uploaded.ok,true,uploaded.message);assert.ok(uploaded.data.photo.uploadedAt);
 const id=uploaded.data.photo.id;
 for(const value of [uploaded,h.app.getPublicStatus(ADDRESS,KEY),h.app.getPublicPhoto(ADDRESS,id)]){
  const json=JSON.stringify(value);for(const forbidden of ['latitude','longitude','accuracy','captureTicket','evidence'])assert.ok(!json.includes(forbidden),forbidden);
 }
 const admin=h.app.getPhoto(h.session,ADDRESS,1);assert.equal(admin.data.photo.evidence.latitude,37.599408);assert.equal(admin.data.photo.evidence.accuracy,12);assert.equal(admin.data.photo.evidence.proofOfVisit,false);
 const key=h.app.digest_(ADDRESS)[0];assert.equal(h.app.getAdminChunk(h.session,key).data.rows[0].photos[0].evidence.longitude,127.06618);
 for(let i=0;i<25;i++)h.app.syncAdminCatalog(h.session,i===0);
 assert.equal(h.app.getAdminChunk(h.session,key).data.rows[0].photos[0].evidence.longitude,127.06618);
 const other=h.staff('staff01');assert.equal(h.app.getAdminChunk(other.session,key).code,'FORBIDDEN');
 assert.ok(!JSON.stringify(h.resources).includes(KEY));
});
test('ambiguous upload can be checked by exact image hash and browser owner without a duplicate write',()=>{
 const h=harness({requireCapture:true}),photo=sample(h),hash=h.app.digest_(Array.from(fakeJpeg()));
 assert.equal(h.app.getPublicUploadReceipt(KEY,ADDRESS,hash).data.saved,false);
 h.dropNextUploadResponse();assert.equal(h.app.uploadPublicPhoto(KEY,ADDRESS,photo).ok,false);
 assert.equal(h.app.getPublicUploadReceipt(KEY,ADDRESS,hash).data.saved,true);
 assert.equal(h.app.getPublicUploadReceipt(OTHER,ADDRESS,hash).data.saved,false);
 assert.equal(h.app.uploadPublicPhoto(KEY,ADDRESS,photo).data.alreadySaved,true);
 assert.equal(h.resources.filter(f=>f.name&&f.name.endsWith('.jpg')).length,1);
});
test('metadata write failure prevents a location-less new upload',()=>{
 const h=harness({requireCapture:true}),photo=sample(h);h.failCatalog(true);
 assert.equal(h.app.uploadPublicPhoto(KEY,ADDRESS,photo).ok,false);
 assert.equal(h.resources.filter(f=>f.name&&f.name.endsWith('.jpg')).length,0);
});
test('real-storage diagnostic is admin-only and never enters visit counts',()=>{
 const h=harness({requireCapture:true}),staff=h.staff('diag-staff');
 assert.equal(h.app.diagnosePhotoStorage('').code,'AUTH');assert.equal(h.app.diagnosePhotoStorage(staff.session).code,'FORBIDDEN');
 const result=h.app.diagnosePhotoStorage(h.session);assert.equal(result.ok,true);assert.equal(result.data.saved,true);assert.equal(result.data.readBackVerified,true);assert.equal(result.data.movedToTrash,true);
 assert.equal(h.trash.length,1);assert.ok(h.trash[0].name.includes('NOT_A_FIELD_VISIT'));
 assert.equal(h.app.getAdminOverview(h.session).data.photos,0);
});
