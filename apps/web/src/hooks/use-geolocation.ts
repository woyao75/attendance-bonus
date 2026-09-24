import { useEffect, useState } from "react";
import type { LocationData } from "../types";

export function useGeolocation() {
  const [location, setLocation] = useState<LocationData>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!navigator.geolocation) {
      setError("当前浏览器不支持定位服务");
      return;
    }
    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        setError(undefined);
        setLocation({
          timestamp: position.timestamp,
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
        });
      },
      () => {
        setLocation(undefined);
        setError("定位失败，请开启精确位置权限");
      },
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 15_000 },
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  return { location, error };
}
