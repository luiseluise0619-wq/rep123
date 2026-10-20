function fakeJpeg(seed = 1, edge = 100) {
  // Minimal structural fixture; not a visual-quality test.
  return Buffer.from([255,216,255,224,0,4,0,0,255,192,0,11,8,edge>>8,edge&255,0,100,1,1,17,0,
    255,218,0,8,1,1,0,0,63,0,seed,0,0,255,217]);
}
module.exports={fakeJpeg};
