const test=require('node:test'),assert=require('node:assert/strict'),distance=require('../web/lib/visit-distance.js');
test('distance is between coordinates, never the supplied GPS accuracy',()=>{
  const a={latitude:37.5665,longitude:126.978,accuracy:24},b={latitude:34.8118,longitude:126.3922};
  const metres=distance.metres(a,b);assert.ok(metres>300000&&metres<320000);assert.equal(distance.metres(a,a),0);
  assert.equal(distance.metres({...a,accuracy:1000},b),metres);assert.ok(Math.abs(distance.metres(b,a)-metres)<1e-8);
  const degree=distance.metres({latitude:0,longitude:0},{latitude:1,longitude:0});assert.ok(Math.abs(degree-111195.08)<.01);
});
test('invalid or absent coordinates are unknown rather than a fake zero-distance',()=>{
  for(const invalid of [null,{}, {latitude:91,longitude:0},{latitude:0,longitude:181},{latitude:'37',longitude:127},{latitude:NaN,longitude:127}])assert.equal(distance.metres(invalid,{latitude:37,longitude:127}),null);
  assert.equal(distance.format(null),'확인 불가');assert.equal(distance.format(NaN),'확인 불가');assert.equal(distance.format(0),'0m');assert.equal(distance.format(999),'999m');assert.equal(distance.format(12345),'12.35km');
  assert.ok(Number.isFinite(distance.metres({latitude:90,longitude:180},{latitude:-90,longitude:0})));
});
