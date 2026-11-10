// Forgiving map taps: small countries are hard to hit with a finger, so a tap picks the country
// under it or, failing that, the nearest country outline within a few screen pixels.
export const TAP_RADIUS = 12;

// Ray casting on one ring of projected { x, y } points.
function insideRing(point, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const a = ring[index], b = ring[previous];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function segmentDistance(point, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared)) : 0;
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

// Screen distance from a tap to a Polygon or MultiPolygon: 0 inside it (holes excluded), otherwise to its nearest edge.
// `project` turns a [lng, lat] position into screen { x, y }.
export function distanceToGeometry(point, geometry, project) {
  const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
  let nearest = Infinity;
  for (const polygon of polygons) {
    const rings = polygon.map(ring => ring.map(project));
    if (rings.length && insideRing(point, rings[0]) && !rings.slice(1).some(hole => insideRing(point, hole))) return 0;
    for (const ring of rings) {
      for (let index = 1; index < ring.length; index += 1) nearest = Math.min(nearest, segmentDistance(point, ring[index - 1], ring[index]));
    }
  }
  return nearest;
}

// Picks the tapped country from the features rendered around the tap. A country containing the tap wins;
// otherwise the closest one within `radius` pixels. Ocean taps farther than that from every coast pick nothing.
// The same country can appear once per map tile, so every copy is measured.
export function pickTapFeature(features, point, project, radius = TAP_RADIUS) {
  let picked = null, pickedDistance = Infinity;
  for (const feature of features) {
    const distance = distanceToGeometry(point, feature.geometry, project);
    if (distance < pickedDistance) { picked = feature; pickedDistance = distance; }
    if (distance === 0) break;
  }
  return pickedDistance <= radius ? picked : null;
}
