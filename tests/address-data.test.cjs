const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const ctx = { window: {} };
for (const name of ['addresses.js', 'data-meta.js']) {
  vm.runInNewContext(fs.readFileSync(path.join(root, 'web', name), 'utf8'), ctx);
}
const data = ctx.window.ADDR_DATA;
const meta = ctx.window.ADDR_META;
const points = [];
for (const [s, gs] of Object.entries(data)) for (const [g, ds] of Object.entries(gs)) {
  for (const [d, ps] of Object.entries(ds)) for (const p of ps) points.push({ s, g, d, p });
}
const sum = ps => ps.reduce((n, r) => n + r.p[3], 0);
test('national source rows and weighted business counts are preserved', () => {
  assert.equal(points.length, 42401);
  assert.equal(new Set(points.map(r => r.p[2])).size, 42401);
  assert.equal(sum(points), 44075);
  assert.equal(Object.keys(data).length, 17);
  assert.ok(!data['전남광주통합특별시']);
  for (const r of points) {
    assert.equal(r.p.length, 7);
    assert.ok(Number.isSafeInteger(r.p[3]) && r.p[3] > 0);
    // Newly split Godeok dongs use explicit local keys in the HWP review;
    // do not invent official codes for them.
    if (r.p[5]) assert.match(r.p[5], /^(\d{10}|name:평택시:고덕[12]동)$/);
  }
});
test('all 11 HWP scopes reconcile, including district and dong counts', () => {
  assert.equal(meta.controls.length, 11);
  for (const c of meta.controls) {
    const scoped = points.filter(r => r.p[6] === c.region);
    assert.equal(sum(scoped), c.businesses, c.region);
    assert.equal(scoped.length, c.addresses, c.region);
    assert.equal(new Set(scoped.map(r => r.g)).size, c.districts, c.region);
    const assigned = scoped.filter(r => r.p[5]);
    assert.equal(new Set(assigned.map(r => JSON.stringify([r.g, r.d, r.p[5]]))).size, c.dongs, c.region);
    assert.equal(sum(assigned), c.assigned, c.region);
    assert.equal(sum(scoped.filter(r => !r.p[5])), c.unresolved, c.region);
  }
  assert.equal(meta.controls.reduce((n, c) => n + c.districts, 0), 199);
  assert.equal(sum(points.filter(r => r.p[6])), 36452);
  assert.equal(points.filter(r => r.p[6]).length, 35176);
  assert.equal(meta.controls.slice(0, 7).reduce((n, c) => n + c.dongs, 0), 1661);
});
test('unresolved addresses remain included and separately marked', () => {
  const unknown = points.filter(r => r.p[6] && !r.p[5]);
  assert.equal(unknown.length, 3);
  assert.equal(sum(unknown), 3);
  assert.deepEqual(unknown.map(r => r.p[2]).sort(), Array.from(meta.unresolved, r => r.address).sort());
  assert.ok(unknown.every(r => r.d === '행정동 미확정'));
});
test('corrected provincial counts and reorganized Incheon districts', () => {
  assert.equal(sum(points.filter(r => r.s === '광주광역시')), 1087);
  assert.equal(sum(points.filter(r => r.s === '전라남도')), 1708);
  assert.ok(data['인천광역시']['제물포구']);
  assert.ok(data['인천광역시']['영종구']);
  assert.ok(data['인천광역시']['서해구']);
  assert.ok(data['인천광역시']['검단구']);
  for (const old of ['서구', '중구', '동구']) assert.ok(!data['인천광역시'][old]);
  const yp = meta.originalYeongdeungpo;
  assert.equal(yp.businesses, 534);
  assert.equal(yp.sameOriginalDistrictBusinesses, 533);
  assert.equal(yp.currentDistrictBusinesses, sum(points.filter(r => r.s === '서울특별시' && r.g === '영등포구')));
  assert.equal(yp.currentDistrictBusinesses, 536);
  assert.equal(yp.incomingFromOtherOriginalDistricts, 3);
});
test('rendered count helpers sum businesses, not address rows', () => {
  const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(Boolean);
  const elements = new Map();
  const element = () => ({ addEventListener() {}, style: {}, classList: { add() {}, remove() {} } });
  const ui = {
    window: { ADDR_DATA: data, ADDR_META: meta, addEventListener() {} },
    document: { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); } },
    L: { divIcon() { return {}; } }, Map, navigator: {}, setTimeout() {}, clearTimeout() {},
  };
  vm.runInNewContext(scripts.join('\n').replace(/initDataInfo\(\);\s*initMap\(\);\s*$/, ''), ui);
  assert.equal(ui.countBusinesses([[null, null, 'a', 33], [null, null, 'b', 1]]), 34);
  assert.equal(ui.countGugun(data['서울특별시']['영등포구']), 536);
  assert.equal(ui.countSido(data['서울특별시']), 8322);
  ui.buildIndex();
  assert.equal(ui.ALL.length, 42401);
  ui.DATA = { 테스트: { 시군구: { 미확정: [[null, null, '좌표 없음', 2, 0, '', '서울']] } } };
  ui.ALL.length = 0;
  ui.buildIndex();
  assert.equal(ui.ALL.length, 1, 'missing coordinates must not remove businesses from the index');
});
