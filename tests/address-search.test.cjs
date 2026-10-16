const test=require('node:test'),assert=require('node:assert/strict'),search=require('../web/address-search.js');
const entries=[
  {s:'서울특별시',g:'영등포구',d:'당산1동',p:[37,127,'서울특별시 영등포구 당산동1가 256-119',3]},
  {s:'서울특별시',g:'영등포구',d:'당산2동',p:[37,127,'서울특별시 영등포구 당산동4가 1',2]},
  {s:'부산광역시',g:'해운대구',d:'중1동',p:[35,129,'부산광역시 해운대구 중동 10',1]}
];
test('search matches all terms across the raw address and administrative dong, without changing data',()=>{
  const copy=JSON.stringify(entries),engine=search.create(entries);
  assert.equal(engine.find('영등포 당산1동').total,1);assert.equal(engine.find('당산동 1가').entries[0],entries[0]);
  assert.equal(engine.find('２５６-１１９').total,1);assert.equal(engine.find('없는주소').total,0);assert.equal(JSON.stringify(entries),copy);
});
test('result cap does not truncate total addresses or weighted businesses',()=>{
  const result=search.create(entries).find('영등포',1);
  assert.equal(result.entries.length,1);assert.equal(result.total,2);assert.equal(result.businesses,5);
  assert.equal(search.create(entries).find('당').tooShort,true);assert.equal(search.create(entries).find('').tooShort,true);
});
