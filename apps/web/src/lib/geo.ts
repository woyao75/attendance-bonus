const EARTH_RADIUS_METERS = 6_371_000;

export function distanceMeters(lat: number, lng: number, centerLat: number, centerLng: number): number {
  const radians = (value: number) => (value * Math.PI) / 180;
  const deltaLat = radians(centerLat - lat);
  const deltaLng = radians(centerLng - lng);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(radians(lat)) * Math.cos(radians(centerLat)) * Math.sin(deltaLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(a));
}
