export const zoomSteps = [0.25, 0.5, 1] as const;
export type Camera = { x: number; y: number; width: number; height: number; zoom: number };
type Footprint = { width: number; height: number };
export function packRooms(sizes: readonly Footprint[]) {
  const columns = Math.ceil(Math.sqrt(sizes.length));
  const gap = 8;
  let x = 0,
    y = 0,
    rowHeight = 0,
    width = 0;
  const positions = sizes.map((size, i) => {
    if (i && i % columns === 0) {
      y += rowHeight + gap;
      x = 0;
      rowHeight = 0;
    }
    const position = { x, y, ...size };
    width = Math.max(width, x + size.width);
    x += size.width + gap;
    rowHeight = Math.max(rowHeight, size.height);
    return position;
  });
  return { positions, width, height: y + rowHeight };
}
export function intersects(camera: Camera, x: number, y: number, width: number, height: number) {
  return (
    (x + width) * camera.zoom > camera.x &&
    x * camera.zoom < camera.x + camera.width &&
    (y + height) * camera.zoom > camera.y &&
    y * camera.zoom < camera.y + camera.height
  );
}
export function pixelRatio(width: number, height: number, dpr: number) {
  return Math.min(dpr, 2, 4096 / Math.max(1, width, height));
}
// In memory: idle + invalidate -> queued; queued + invalidate -> queued;
// frame -> idle before painting. Hide/unmount cancels. Show queues a fresh paint.
export function frameQueue(paint: () => void) {
  let frame: number | undefined;
  return {
    request() {
      if (frame === undefined && !document.hidden)
        frame = requestAnimationFrame(() => {
          frame = undefined;
          if (!document.hidden) paint();
        });
    },
    cancel() {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
    },
  };
}
