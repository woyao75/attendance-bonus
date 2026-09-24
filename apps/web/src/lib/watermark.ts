import type { LocationData } from "../types";

export interface WatermarkData {
  studentId: string;
  name: string;
  location?: LocationData;
  timestamp?: Date;
}

function formatDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:${pad(date.getSeconds())}`;
}

function getLines(data: WatermarkData): string[] {
  const location = data.location;
  const coordinate = location
    ? `${location.lat.toFixed(6)}, ${location.lng.toFixed(6)}${location.accuracy ? ` +/-${Math.round(location.accuracy)}m` : ""}`
    : "定位获取中";
  return [
    `${data.studentId} ${data.name}`,
    formatDate(data.timestamp ?? new Date()),
    location?.address ?? coordinate,
  ];
}

export function estimateVideoLuminance(video: HTMLVideoElement): number {
  if (!video.videoWidth || !video.videoHeight) return 80;
  const sample = document.createElement("canvas");
  sample.width = 16;
  sample.height = 16;
  const context = sample.getContext("2d", { willReadFrequently: true });
  if (!context) return 80;
  context.drawImage(video, 0, 0, sample.width, sample.height);
  const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
  let total = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    total +=
      0.2126 * pixels[index] +
      0.7152 * pixels[index + 1] +
      0.0722 * pixels[index + 2];
  }
  return total / (pixels.length / 4);
}

export function drawWatermark(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  data: WatermarkData,
  luminance: number,
): void {
  const scale = Math.max(1, width / 720);
  const padding = 16 * scale;
  const fontSize = 16 * scale;
  const lineHeight = 24 * scale;
  const lines = getLines(data);
  const maxTextWidth = width - padding * 2;
  const textColor =
    luminance > 145 ? "rgba(15, 23, 42, 0.92)" : "rgba(255, 255, 255, 0.95)";
  const background =
    luminance > 145 ? "rgba(255, 255, 255, 0.48)" : "rgba(15, 23, 42, 0.50)";

  context.font = `600 ${fontSize}px system-ui, sans-serif`;
  const contentWidth = Math.min(
    maxTextWidth,
    Math.max(...lines.map((line) => context.measureText(line).width)) +
      padding * 2,
  );
  const contentHeight = lines.length * lineHeight + padding * 1.5;
  const x = padding;
  const y = height - contentHeight - padding;

  context.fillStyle = background;
  context.fillRect(x, y, contentWidth, contentHeight);
  context.fillStyle = textColor;
  context.textBaseline = "top";
  lines.forEach((line, index) => {
    const truncated =
      context.measureText(line).width > maxTextWidth - padding * 2
        ? `${line.slice(0, 24)}...`
        : line;
    context.fillText(
      truncated,
      x + padding,
      y + padding * 0.75 + index * lineHeight,
    );
  });
}

export async function captureWatermarkedPhoto(
  video: HTMLVideoElement,
  data: WatermarkData,
): Promise<Blob> {
  if (!video.videoWidth || !video.videoHeight)
    throw new Error("相机画面尚未就绪");
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("无法初始化照片画布");
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  drawWatermark(
    context,
    canvas.width,
    canvas.height,
    data,
    estimateVideoLuminance(video),
  );
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("照片生成失败"))),
      "image/jpeg",
      0.92,
    );
  });
}
