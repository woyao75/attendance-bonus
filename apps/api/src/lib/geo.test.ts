import { describe, expect, it } from "vitest";
import { haversineDistanceMeters, isWithinGeofence } from "./geo.js";

describe("haversineDistanceMeters", () => {
  it("returns zero for the same point", () => {
    expect(haversineDistanceMeters(30.2741, 120.1551, 30.2741, 120.1551)).toBe(0);
  });

  it("calculates a known one-degree equatorial distance", () => {
    expect(haversineDistanceMeters(0, 0, 0, 1)).toBeCloseTo(111_195, -2);
  });

  it("includes the fence boundary", () => {
    expect(isWithinGeofence(0, 0, 0, 0, 0).withinFence).toBe(true);
  });
});
