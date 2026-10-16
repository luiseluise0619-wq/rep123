const test=require('node:test'),assert=require('node:assert/strict');
const {harness,fakeJpeg,ADDRESS}=require('./helpers/photo-harness.cjs');
const KEY='a'.repeat(64),OTHER='b'.repeat(64);
function sample(h,seed=1,key=KEY){const gps={latitude:37.599408,longitude:127.06618,accuracy:12,timestamp:Date.now()},permit=h.app.beginPublicCapture(key,ADDRESS,gps);assert.equal(permit.ok,true);return {base64:fakeJpeg(seed).toString('base64'),publicShare:true,confirmReadable:true,visitDate:'2026-10-16',captureTicket:permit.data.ticket,capturedAt:Date.now()};}
test('historical optional GPS mode rejects invalid, stale or cross-device location permits',()=>{
 const h=harness({requireCapture:true,requireLocation:true}),photo=sample(h);
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
 const h=harness({requireCapture:true,requireLocation:true}),photo=sample(h),uploaded=h.app.uploadPublicPhoto(KEY,ADDRESS,photo);
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
test('metadata write failure prevents an upload without capture timestamps',()=>{
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

test('server stores distance from signed current coordinates to the original destination, not client accuracy',()=>{
 const sourceText='window.ADDR_DATA = '+JSON.stringify({서울:{영등포구:{당산동:[[37.5665,126.978,ADDRESS,2,1,'code','서울']]}}})+';';
 const h=harness({sourceText,requireCapture:true,requireLocation:true}),gps={latitude:34.8118,longitude:126.3922,accuracy:24,timestamp:Date.now()};
 const permit=h.app.beginPublicCapture(KEY,ADDRESS,gps);assert.equal(permit.ok,true);
 const uploaded=h.app.uploadPublicPhoto(KEY,ADDRESS,{...sample(h),captureTicket:permit.data.ticket,distanceMeters:24});assert.equal(uploaded.ok,true);
 const evidence=h.app.getPhoto(h.session,ADDRESS,1).data.photo.evidence;assert.ok(evidence.distanceMeters>300000&&evidence.distanceMeters<320000);assert.equal(evidence.accuracy,24);assert.equal(evidence.destination.latitude,37.5665);
 assert.ok(!JSON.stringify(uploaded).includes('distanceMeters'));assert.ok(!JSON.stringify(h.app.getPublicStatus(ADDRESS,KEY)).includes('distanceMeters'));
});

test('production camera permits and stored timestamps work without requesting or retaining GPS',()=>{
 const h=harness({requireCapture:true});assert.equal(h.app.PHOTO_LIMITS_.requireLocation,false);
 const permit=h.app.beginPublicCapture(KEY,ADDRESS);assert.equal(permit.ok,true,permit.message);
 const payload=JSON.parse(Buffer.from(permit.data.ticket.split('.')[0],'base64url').toString());assert.equal(payload.kind,'camera-only-v1');
 for(const key of ['latitude','longitude','accuracy','positionAt','destination','distanceMeters'])assert.ok(!Object.hasOwn(payload,key));
 const photo={base64:fakeJpeg().toString('base64'),publicShare:true,confirmReadable:true,visitDate:'2026-10-16',captureTicket:permit.data.ticket,capturedAt:Date.now(),latitude:37,longitude:127};
 assert.equal(h.app.uploadPublicPhoto(OTHER,ADDRESS,photo).code,'CAPTURE');assert.equal(h.app.uploadPublicPhoto(KEY,ADDRESS,{...photo,captureTicket:''}).code,'CAPTURE');
 assert.equal(h.app.uploadPublicPhoto(KEY,ADDRESS,photo).ok,true);
 const evidence=h.app.getPhoto(h.session,ADDRESS,1).data.photo.evidence;assert.equal(evidence.locationCollected,false);assert.ok(evidence.capturedAt);assert.ok(evidence.receivedAt);
 for(const key of ['latitude','longitude','accuracy','positionAt','destination','distanceMeters'])assert.ok(!Object.hasOwn(evidence,key));
 const ignored=h.app.beginPublicCapture(KEY,ADDRESS,{latitude:91,longitude:999,accuracy:0});assert.equal(ignored.ok,true);
 assert.ok(!Buffer.from(ignored.data.ticket.split('.')[0],'base64url').toString().includes('latitude'));
});

test('GPS shutdown preserves historical evidence but discards location from an old valid pending ticket',()=>{
 const h=harness({requireCapture:true,requireLocation:true}),old=sample(h,1),pending=sample(h,2);
 assert.equal(h.app.uploadPublicPhoto(KEY,ADDRESS,old).ok,true);
 h.app.PHOTO_LIMITS_={...h.app.PHOTO_LIMITS_,requireLocation:false};
 assert.equal(h.app.uploadPublicPhoto(KEY,ADDRESS,pending).ok,true);
 const first=h.app.getPhoto(h.session,ADDRESS,1).data.photo.evidence,second=h.app.getPhoto(h.session,ADDRESS,2).data.photo.evidence;
 assert.equal(first.latitude,37.599408);assert.equal(second.locationCollected,false);assert.ok(!Object.hasOwn(second,'latitude'));
 for(let i=0;i<25;i++)h.app.syncAdminCatalog(h.session,i===0);
 assert.equal(h.app.getPhoto(h.session,ADDRESS,1).data.photo.evidence.latitude,37.599408);
});
