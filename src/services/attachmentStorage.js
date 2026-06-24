const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { env } = require("../config/env");

const attachmentRoot = path.resolve(env.attachmentRoot);
const legacyAttachmentRoot = path.resolve(__dirname, "../../assets/attachments");

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
  attachmentRoot,
  legacyAttachmentRoot,
  storeDataUrlAttachment,
  readAttachmentAsDataUrl,
  deleteStoredAttachment
};
