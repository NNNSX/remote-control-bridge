import path from "node:path";

export const MAX_TEXT_PREVIEW_BYTES = 256 * 1024;
export const MAX_IMAGE_PREVIEW_BYTES = 16 * 1024 * 1024;

const BINARY_EXTENSIONS = new Set([
  ".7z", ".arrow", ".bin", ".bz2", ".class", ".ckpt", ".db", ".dll",
  ".doc", ".docx", ".dylib", ".exe", ".feather", ".gz", ".h5", ".hdf5",
  ".iso", ".jar", ".joblib", ".model", ".npy", ".npz", ".onnx", ".parquet",
  ".pb", ".pdf", ".pickle", ".pkl", ".pt", ".pth", ".rar", ".safetensors",
  ".so", ".sqlite", ".tar", ".tgz", ".war", ".weights", ".xls", ".xlsx",
  ".xz", ".zip",
]);

export function isKnownBinaryPath(filePath) {
  return BINARY_EXTENSIONS.has(path.posix.extname(String(filePath || "")).toLowerCase());
}

export function decodeTextPreview(buffer, truncated = false) {
  if (buffer.includes(0)) throw new Error("binary files cannot be previewed");
  let content;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    content = decoder.decode(buffer, { stream: truncated });
    if (!truncated) content += decoder.decode();
  } catch {
    throw new Error("file is not valid UTF-8 text and cannot be previewed");
  }
  let controls = 0;
  for (const character of content) {
    const code = character.charCodeAt(0);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13 && code !== 12) controls += 1;
  }
  if (content.length && controls / content.length > 0.01) throw new Error("binary files cannot be previewed");
  return content;
}
