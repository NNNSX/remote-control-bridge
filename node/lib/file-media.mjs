import path from "node:path";

const IMAGE_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".bmp", "image/bmp"],
  [".avif", "image/avif"],
  [".ico", "image/x-icon"],
]);

export function mediaTypeForPath(filePath) {
  return IMAGE_TYPES.get(path.posix.extname(String(filePath || "")).toLowerCase()) || null;
}

