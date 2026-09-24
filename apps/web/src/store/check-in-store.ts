import { create } from "zustand";
import type { CheckIn, LocationData, Task } from "../types";

interface CheckInStore {
  task?: Task;
  checkIn?: CheckIn;
  location?: LocationData;
  setTask: (task: Task) => void;
  setCheckIn: (checkIn: CheckIn | undefined) => void;
  setLocation: (location: LocationData | undefined) => void;
}

export const useCheckInStore = create<CheckInStore>((set) => ({
  setTask: (task) => set({ task }),
  setCheckIn: (checkIn) => set({ checkIn }),
  setLocation: (location) => set({ location }),
}));
