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
  attachmentRoot,
  legacyAttachmentRoot,
  storeDataUrlAttachment,
  readAttachmentAsDataUrl,
  deleteStoredAttachment
};
