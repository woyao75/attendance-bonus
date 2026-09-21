const EARTH_RADIUS_METERS = 6_371_000;

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

export function haversineDistanceMeters(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number
): number {
  const deltaLat = toRadians(toLat - fromLat);
  const deltaLng = toRadians(toLng - fromLng);
  const fromLatRadians = toRadians(fromLat);
  const toLatRadians = toRadians(toLat);

  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(fromLatRadians) * Math.cos(toLatRadians) * Math.sin(deltaLng / 2) ** 2;

  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(a));
}

export function isWithinGeofence(
  lat: number,
  lng: number,
  centerLat: number,
  centerLng: number,
  radiusMeters: number
): { distanceMeters: number; withinFence: boolean } {
  const distanceMeters = haversineDistanceMeters(lat, lng, centerLat, centerLng);
  return { distanceMeters, withinFence: distanceMeters <= radiusMeters };
}
