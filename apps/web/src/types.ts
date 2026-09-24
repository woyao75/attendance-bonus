export type CheckInStatus =
  | "NOT_CHECKED"
  | "EMAIL_PENDING"
  | "EMAIL_SENT"
  | "REVIEWING"
  | "APPROVED"
  | "REJECTED"
  | "EMAIL_ERROR";

export interface Task {
  status: string;
  id: string;
  title: string;
  startTime: string;
  endTime: string;
  gestureImgUrl: string | null;
  centerLat: number;
  centerLng: number;
  radius: number;
}

export interface CheckIn {
  id: string;
  status: CheckInStatus;
  photoUrl: string | null;
  lat: number | null;
  lng: number | null;
  address: string | null;
  rejectReason: string | null;
  createdAt: string;
}

export interface LocationData {
  timestamp: number;
  lat: number;
  lng: number;
  accuracy: number;
  address?: string;
}
