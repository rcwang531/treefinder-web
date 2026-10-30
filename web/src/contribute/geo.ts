// Geometry helpers for contributed polygons: containment in a site square and area.
type Ring = number[][];

/** Ray-casting point-in-ring test (lon/lat). */
export function inRing([x, y]: number[], ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** True when every vertex of `poly` lies inside the site extent. */
export function polygonInside(poly: GeoJSON.Polygon, extent: GeoJSON.Polygon): boolean {
  return poly.coordinates.every((ring) => ring.every((pt) => inRing(pt, extent.coordinates[0])));
}

/** Approximate area in m² (equirectangular projection; fine at tree scale). */
export function areaM2(poly: GeoJSON.Polygon): number {
  const R = 6_371_008.8;
  const ringArea = (ring: Ring) => {
    const lat0 = (ring.reduce((s, p) => s + p[1], 0) / ring.length) * (Math.PI / 180);
    let a = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[i + 1];
      a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a / 2) * (Math.PI / 180) ** 2 * R * R * Math.cos(lat0);
  };
  const [outer, ...holes] = poly.coordinates;
  return ringArea(outer) - holes.reduce((s, h) => s + ringArea(h), 0);
}
