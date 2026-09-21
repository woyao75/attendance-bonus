import { useEffect } from "react";
import { drawWatermark, estimateVideoLuminance, type WatermarkData } from "../lib/watermark";

export function useWatermarkPreview(
  video: HTMLVideoElement | null,
  canvas: HTMLCanvasElement | null,
  data: WatermarkData
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
        const rect = video.getBoundingClientRect();
        const pixelRatio = window.devicePixelRatio || 1;
        const width = Math.max(1, Math.round(rect.width * pixelRatio));
        const height = Math.max(1, Math.round(rect.height * pixelRatio));
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
