import { useEffect } from "react";
import {
  drawWatermark,
  estimateVideoLuminance,
  type WatermarkData,
} from "../lib/watermark";

export function useWatermarkPreview(
  video: HTMLVideoElement | null,
  canvas: HTMLCanvasElement | null,
  data: WatermarkData,
) {
  useEffect(() => {
    if (!video || !canvas) return;
    let frameId = 0;
    let luminance = 80;
    let lastSample = 0;
    const render = (time: number) => {
      if (video.videoWidth && video.videoHeight) {
        if (time - lastSample > 500) {
          luminance = estimateVideoLuminance(video);
          lastSample = time;
        }
        const width = video.videoWidth;
        const height = video.videoHeight;
        const rect = video.getBoundingClientRect();
        const scale = Math.min(rect.width / width, rect.height / height);
        canvas.style.width = `${width * scale}px`;
        canvas.style.height = `${height * scale}px`;
        canvas.style.left = `${(rect.width - width * scale) / 2}px`;
        canvas.style.top = `${(rect.height - height * scale) / 2}px`;
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }
        const context = canvas.getContext("2d");
        if (context) {
          context.clearRect(0, 0, width, height);
          drawWatermark(context, width, height, data, luminance);
        }
      }
      frameId = requestAnimationFrame(render);
    };
    frameId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frameId);
  }, [video, canvas, data]);
}
