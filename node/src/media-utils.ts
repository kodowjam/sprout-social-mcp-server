/**
 * Media utilities for Google Drive URL handling and media type detection.
 */

export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

const GDRIVE_PATTERNS: RegExp[] = [
  /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/,
  /drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/,
  /drive\.usercontent\.google\.com\/download\?id=([a-zA-Z0-9_-]+)/,
  /drive\.google\.com\/uc\?.*id=([a-zA-Z0-9_-]+)/,
];

const IMAGE_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
]);

const VIDEO_CONTENT_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/x-msvideo",
  "video/webm",
  "video/mpeg",
  "video/x-matroska",
]);

const DOCUMENT_CONTENT_TYPES = new Set(["application/pdf"]);

const DOCUMENT_EXTENSIONS = new Set([".pdf"]);

const PDF_MAGIC = "%PDF";

const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
]);

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".avi",
  ".webm",
  ".mpeg",
  ".mpg",
  ".mkv",
]);

/**
 * Check if a URL is a Google Drive link.
 */
export function isGoogleDriveUrl(url: string): boolean {
  return extractGdriveFileId(url) !== null;
}

/**
 * Extract the file ID from a Google Drive URL. Returns null if not a Drive URL.
 */
export function extractGdriveFileId(url: string): string | null {
  for (const pattern of GDRIVE_PATTERNS) {
    const match = url.match(pattern);
    if (match) {
      return match[1];
    }
  }
  return null;
}

/**
 * Check whether the leading bytes of a file are the %PDF magic bytes.
 */
export function isPdfBytes(head: Uint8Array | null | undefined): boolean {
  if (!head || head.length < PDF_MAGIC.length) return false;
  for (let i = 0; i < PDF_MAGIC.length; i++) {
    if (head[i] !== PDF_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Detect whether media is PHOTO, VIDEO or DOCUMENT (PDF) based on the file's
 * leading bytes, content-type or filename.
 * Returns "PHOTO", "VIDEO" or "DOCUMENT". Defaults to "PHOTO" if indeterminate.
 */
export function detectMediaType(
  contentType: string | null,
  filename: string | null,
  head?: Uint8Array | null
): string {
  if (isPdfBytes(head)) return "DOCUMENT";

  if (contentType) {
    const ct = contentType.split(";")[0].trim().toLowerCase();
    if (DOCUMENT_CONTENT_TYPES.has(ct)) return "DOCUMENT";
    if (VIDEO_CONTENT_TYPES.has(ct)) return "VIDEO";
    if (IMAGE_CONTENT_TYPES.has(ct)) return "PHOTO";
  }

  if (filename) {
    const ext = getExtension(filename);
    if (DOCUMENT_EXTENSIONS.has(ext)) return "DOCUMENT";
    if (VIDEO_EXTENSIONS.has(ext)) return "VIDEO";
    if (IMAGE_EXTENSIONS.has(ext)) return "PHOTO";
  }

  return "PHOTO";
}

function getExtension(filename: string): string {
  const dotIdx = filename.lastIndexOf(".");
  if (dotIdx === -1) return "";
  return filename.slice(dotIdx).toLowerCase();
}
