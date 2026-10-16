// Coordinate-to-coordinate surface distance, not GPS accuracy or driving distance.
var PHOTO_DISTANCE_ = (function () {
  function valid(point) {
    return !!point && Number.isFinite(point.latitude) && Number.isFinite(point.longitude) &&
      point.latitude >= -90 && point.latitude <= 90 && point.longitude >= -180 && point.longitude <= 180;
  }
  function metres(from, to) {
    if (!valid(from) || !valid(to)) return null;
    var rad = Math.PI / 180, lat1 = from.latitude * rad, lat2 = to.latitude * rad,
      dlat = (to.latitude - from.latitude) * rad, dlon = (to.longitude - from.longitude) * rad;
    var a = Math.sin(dlat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2) ** 2;
    return 6371008.8 * 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, a))));
  }
  function format(value) {
    if (!Number.isFinite(value) || value < 0) return '확인 불가';
    return value < 1000 ? Math.round(value) + 'm' : (value / 1000).toFixed(2) + 'km';
  }
  return Object.freeze({metres: metres, format: format});
})();
if (typeof window !== 'undefined') window.PHOTO_DISTANCE_ = PHOTO_DISTANCE_;
if (typeof module !== 'undefined' && module.exports) module.exports = PHOTO_DISTANCE_;
