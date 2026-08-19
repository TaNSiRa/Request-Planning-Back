const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { env } = require("../config/env");

const attachmentRoot = path.resolve(env.attachmentRoot);
const legacyAttachmentRoot = path.resolve(__dirname, "../../assets/attachments");

// Accepted attachment kinds: extension -> the MIME types a browser reports for
// it. An upload must match on BOTH sides (extension AND content type) so a
// renamed executable can't ride in as ".pdf". Browsers sometimes send an empty
// or generic type for office documents, so "application/octet-stream" and "" are
// tolerated when the extension itself is on the list.
//
// To allow another kind, add one entry here and mirror it in the frontend's
// pickFileAttachments() accept list (create_request_page.dart).
const ALLOWED_ATTACHMENTS = {
  ".pdf": ["application/pdf"],
  ".png": ["image/png"],
  ".jpg": ["image/jpeg"],
  ".jpeg": ["image/jpeg"],
  ".webp": ["image/webp"],
  ".doc": ["application/msword"],
  ".docx": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ".xls": ["application/vnd.ms-excel"],
  ".xlsx": ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]
};

const GENERIC_CONTENT_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream"]);

// What the first bytes of a file must look like for each accepted extension.
// Keyed by EXTENSION rather than by the declared content type on purpose: the
// whitelist above tolerates a generic "application/octet-stream" (browsers send
// it for Office files), so keying on the declared type would let anything
// claiming to be generic skip the check entirely. The extension is the thing
// the rest of the pipeline believes, so the extension is what has to be true.
//
// `at` lets a signature sit past the start — WebP is "RIFF" then four length
// bytes then "WEBP".
const B = s => [...s].map(c => c.charCodeAt(0));
const SIG = {
  pdf: [{ at: 0, bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }],                    // %PDF-
  png: [{ at: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
  jpeg: [{ at: 0, bytes: [0xff, 0xd8, 0xff] }],
  webp: [{ at: 0, bytes: B("RIFF") }, { at: 8, bytes: B("WEBP") }],
  // docx/xlsx are ZIP containers. The two rarer ZIP headers (empty archive,
  // spanned archive) are not valid Office files, so only the normal one counts.
  zip: [{ at: 0, bytes: [0x50, 0x4b, 0x03, 0x04] }],
  // Legacy Office (.doc/.xls) is an OLE2 compound document.
  ole2: [{ at: 0, bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] }]
};

const EXTENSION_SIGNATURES = {
  ".pdf": ["pdf"],
  ".png": ["png"],
  ".jpg": ["jpeg"],
  ".jpeg": ["jpeg"],
  ".webp": ["webp"],
  ".doc": ["ole2"],
  ".docx": ["zip"],
  ".xls": ["ole2"],
  ".xlsx": ["zip"]
};

function matchesSignature(buffer, name) {
  return SIG[name].every(part => part.bytes.every((byte, i) => buffer[part.at + i] === byte));
}

// The extension and the declared content type both come from the client, so
// agreeing with each other proves nothing — a renamed executable carries
// whatever name and type its sender chooses. This reads the bytes that actually
// arrived, which the sender cannot fake without shipping a real file of that
// type.
function assertMagicByte(fileName, buffer) {
  const ext = path.extname(`${fileName || ""}`).toLowerCase();
  const expected = EXTENSION_SIGNATURES[ext];
  if (!expected) return; // unreachable: assertAllowedAttachment ran first
  if (expected.some(name => matchesSignature(buffer, name))) return;
  throw badRequest(
    `File "${fileName}" is not a real ${ext.slice(1).toUpperCase()} file — its contents do not match its extension`
  );
}

const ALLOWED_EXTENSION_LIST = Object.keys(ALLOWED_ATTACHMENTS).join(", ");

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// Throws a 400 unless the (fileName, contentType) pair is on the whitelist.
// Only the extension actually present on the uploaded name counts — the
// safeExtension() fallbacks below must not be able to invent an allowed one.
function assertAllowedAttachment(fileName, contentType) {
  const ext = path.extname(`${fileName || ""}`).toLowerCase();
  const allowedTypes = ALLOWED_ATTACHMENTS[ext];
  if (!allowedTypes) {
    throw badRequest(
      `File type "${ext || path.basename(`${fileName || "unnamed"}`)}" is not allowed. ` +
      `Allowed types: ${ALLOWED_EXTENSION_LIST}`
    );
  }
  const type = `${contentType || ""}`.split(";")[0].trim().toLowerCase();
  if (GENERIC_CONTENT_TYPES.has(type)) return;
  if (!allowedTypes.includes(type)) {
    throw badRequest(`File "${fileName}" does not match its type (${type}) and was rejected`);
  }
}

function splitDataUrl(dataUrl) {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(dataUrl || "");
  if (!match) throw new Error("Invalid attachment data URL");
  const contentType = match[1] || "application/octet-stream";
  const isBase64 = Boolean(match[2]);
  const payload = match[3] || "";
  const buffer = isBase64 ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
  return { contentType, buffer };
}

// Size ceiling for ONE file, measured on the decoded bytes. Until now nothing
// checked this: the only thing standing between an upload and the disk was the
// whole-body limit, so the failure a user met was a bare 413 with no idea which
// file caused it. Checked here, they get the name and the number.
function assertAttachmentSize(fileName, buffer) {
  const maxBytes = env.maxAttachmentMb * 1024 * 1024;
  if (buffer.length <= maxBytes) return;
  const mb = (buffer.length / (1024 * 1024)).toFixed(1);
  throw badRequest(
    `File "${fileName || "attachment"}" is ${mb} MB, over the ${env.maxAttachmentMb} MB limit for a single file`
  );
}

function safeExtension(fileName, contentType) {
  const ext = path.extname(fileName || "").toLowerCase().replace(/[^a-z0-9.]/g, "");
  if (ext && ext.length <= 12) return ext;
  if (contentType === "application/pdf") return ".pdf";
  if (contentType?.includes("spreadsheet") || contentType?.includes("excel")) return ".xlsx";
  if (contentType?.startsWith("image/png")) return ".png";
  if (contentType?.startsWith("image/jpeg")) return ".jpg";
  if (contentType?.startsWith("image/webp")) return ".webp";
  return ".bin";
}

function safePathSegment(value, fallback) {
  const text = `${value || ""}`
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/\.+$/g, "");
  return text || fallback;
}

function storageFolderParts(context = {}) {
  const createdAt = context.createdAt ? new Date(context.createdAt) : new Date();
  const validDate = Number.isNaN(createdAt.getTime()) ? new Date() : createdAt;
  const year = `${validDate.getFullYear()}`;
  const month = `${validDate.getMonth() + 1}`.padStart(2, "0");
  return [
    safePathSegment(context.section, "Unknown Section"),
    safePathSegment(context.branch, "Unknown Branch"),
    safePathSegment(context.department, "Unknown Department"),
    year,
    month,
    safePathSegment(context.requestNo, "Unknown Request"),
    safePathSegment(context.bucket, "Request Files")
  ];
}

function resolveInside(root, storagePath) {
  const fullPath = path.resolve(root, storagePath || "");
  const relative = path.relative(root, fullPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Invalid attachment path");
  }
  return fullPath;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function storeDataUrlAttachment({ dataUrl, fileName, contentType }, context = {}) {
  const parsed = splitDataUrl(dataUrl);
  const finalContentType = contentType || parsed.contentType;
  // Single choke point — every upload path in the app goes through here.
  assertAllowedAttachment(fileName, finalContentType);
  assertAttachmentSize(fileName, parsed.buffer);
  assertMagicByte(fileName, parsed.buffer);
  const dir = path.join(attachmentRoot, ...storageFolderParts(context));
  await fs.mkdir(dir, { recursive: true });
  const storedName = `${crypto.randomUUID()}${safeExtension(fileName, finalContentType)}`;
  const fullPath = path.join(dir, storedName);
  await fs.writeFile(fullPath, parsed.buffer);
  return {
    storagePath: path.relative(attachmentRoot, fullPath).replaceAll("\\", "/"),
    fileSize: parsed.buffer.length,
    contentType: finalContentType || "application/octet-stream"
  };
}

async function readAttachmentAsDataUrl(storagePath, contentType) {
  const fullPath = resolveInside(attachmentRoot, storagePath);
  const legacyPath = resolveInside(legacyAttachmentRoot, storagePath);
  const readablePath = (await fileExists(fullPath)) ? fullPath : legacyPath;
  const buffer = await fs.readFile(readablePath);
  return `data:${contentType || "application/octet-stream"};base64,${buffer.toString("base64")}`;
}

async function deleteStoredAttachment(storagePath) {
  if (!storagePath) return;
  await deleteInsideRoot(attachmentRoot, storagePath);
  await deleteInsideRoot(legacyAttachmentRoot, storagePath);
}

async function deleteInsideRoot(root, storagePath) {
  const fullPath = resolveInside(root, storagePath);
  try {
    await fs.unlink(fullPath);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    return;
  }
  await removeEmptyParents(path.dirname(fullPath), root);
}

async function removeEmptyParents(dir, root) {
  let current = dir;
  while (current !== root && path.relative(root, current) && !path.relative(root, current).startsWith("..")) {
    try {
      await fs.rmdir(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

module.exports = {
  ALLOWED_ATTACHMENTS,
  assertAllowedAttachment,
  assertAttachmentSize,
  assertMagicByte,
  attachmentRoot,
  legacyAttachmentRoot,
  splitDataUrl,
  storeDataUrlAttachment,
  readAttachmentAsDataUrl,
  deleteStoredAttachment
};
