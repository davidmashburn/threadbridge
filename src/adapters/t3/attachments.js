const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

// These match stock T3 v0.1.0's attachmentStore path rules. The attachment
// id is opaque metadata; the filename extension is derived independently.
const SAFE_IMAGE_EXTENSIONS = [
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".tiff",
  ".webp",
];
const MIME_TO_IMAGE_EXTENSION = {
  "image/avif": ".avif",
  "image/bmp": ".bmp",
  "image/gif": ".gif",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/svg+xml": ".svg",
  "image/tiff": ".tiff",
  "image/webp": ".webp",
};
const EXTENSION_TO_MIME = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".tiff": "image/tiff",
  ".webp": "image/webp",
  ".csv": "text/csv",
  ".json": "application/json",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".zip": "application/zip",
  ".bin": "application/octet-stream",
};
const STOCK_ATTACHMENT_EXTENSIONS = [...SAFE_IMAGE_EXTENSIONS, ".bin"];
const STOCK_ATTACHMENT_ID_RE = /^[a-z0-9_-]{1,128}$/i;
const STOCK_ID_WITH_EXTENSION_RE =
  /^[a-z0-9_]+(?:-[a-z0-9_]+)*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-([a-z0-9]{1,10}))?$/i;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_ATTACHMENT_NAME_LENGTH = 255;
const MAX_MIME_TYPE_LENGTH = 100;

function warning(code, message, extra = {}) {
  return { code, message, ...extra };
}

function isPathInside(candidate, root) {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

function realPathInside(candidate, root) {
  let realCandidate;
  let realRoot;
  try {
    realCandidate = fs.realpathSync(candidate);
    realRoot = fs.realpathSync(root);
  } catch {
    return false;
  }
  return isPathInside(realCandidate, realRoot);
}

function lstatOrNull(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function safeExistingDirectory(directory, parentRoot = null) {
  const stat = lstatOrNull(directory);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return null;
  let realDirectory;
  try {
    realDirectory = fs.realpathSync(directory);
  } catch {
    return null;
  }
  if (parentRoot && !realPathInside(realDirectory, parentRoot)) return null;
  return realDirectory;
}

function safeExistingFile(filePath, root) {
  if (!isPathInside(filePath, root)) return null;
  let realFile;
  try {
    realFile = fs.realpathSync(filePath);
  } catch {
    return null;
  }
  if (!realPathInside(realFile, root)) return null;
  try {
    return fs.statSync(realFile).isFile() ? realFile : null;
  } catch {
    return null;
  }
}

function stockAttachmentId(id) {
  return typeof id === "string" && id === id.trim() && STOCK_ATTACHMENT_ID_RE.test(id) ? id : null;
}

function stockImageExtension(mimeType, fileName, sourcePath = "") {
  const bareMimeType = typeof mimeType === "string" ? mimeType.split(";", 1)[0].trim().toLowerCase() : "";
  if (MIME_TO_IMAGE_EXTENSION[bareMimeType]) return MIME_TO_IMAGE_EXTENSION[bareMimeType];

  const fileNameExtension = typeof fileName === "string" ? path.extname(fileName).toLowerCase() : "";
  if (SAFE_IMAGE_EXTENSIONS.includes(fileNameExtension)) return fileNameExtension;

  const sourceExtension = sourcePath ? path.extname(sourcePath).toLowerCase() : "";
  if (SAFE_IMAGE_EXTENSIONS.includes(sourceExtension)) return sourceExtension;
  return ".bin";
}

function stockFileExtension(fileName) {
  const extension = typeof fileName === "string" ? path.extname(fileName).toLowerCase() : "";
  if (extension === ".part" || !/^\.[a-z0-9]{1,10}$/.test(extension)) return ".bin";
  return extension;
}

function attachmentExtension(type, mimeType, name, sourcePath = "") {
  if (type === "image") return stockImageExtension(mimeType, name, sourcePath);
  return stockFileExtension(name || sourcePath);
}

function mimeTypeForExtension(type, extension) {
  if (type === "image") return EXTENSION_TO_MIME[extension] || "image/octet-stream";
  return EXTENSION_TO_MIME[extension] || "application/octet-stream";
}

function rawAttachmentPath(attachment) {
  return [attachment.path, attachment.filePath, attachment.localPath, attachment.sourcePath].find(
    (value) => typeof value === "string" && value.trim(),
  );
}

function sourceRoots(ir, sourceDbPath) {
  const roots = [];
  if (sourceDbPath) roots.push(path.dirname(path.resolve(sourceDbPath)));
  for (const candidate of [ir.thread?.workspaceRoot, ir.project?.workspaceRoot]) {
    if (typeof candidate === "string" && candidate.trim()) roots.push(path.resolve(candidate));
  }
  return [...new Set(roots)];
}

function resolveLocalPath(attachment, ir, sourceDbPath) {
  const raw = rawAttachmentPath(attachment);
  if (!raw || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return null;

  const candidate = path.resolve(raw);
  for (const root of sourceRoots(ir, sourceDbPath)) {
    if (!isPathInside(candidate, root)) continue;
    const real = safeExistingFile(candidate, root);
    if (real) return real;
  }
  return null;
}

function stockIdExtension(id) {
  return stockAttachmentId(id)?.match(STOCK_ID_WITH_EXTENSION_RE)?.[1]?.toLowerCase() || null;
}

function resolveT3Path(attachment, sourceDbPath) {
  const id = stockAttachmentId(attachment.id);
  if (!sourceDbPath || !id) return null;

  const sourceRoot = path.dirname(path.resolve(sourceDbPath));
  const attachmentsDir = safeExistingDirectory(path.join(sourceRoot, "attachments"), sourceRoot);
  if (!attachmentsDir) return null;

  const extension = attachmentExtension(attachment.type, attachment.mimeType, attachment.name);
  const candidates = [`${id}${extension}`];
  const idExtension = stockIdExtension(id);
  if (idExtension) candidates.push(`${id}.${idExtension}`);
  for (const fallbackExtension of STOCK_ATTACHMENT_EXTENSIONS) {
    candidates.push(`${id}${fallbackExtension}`);
  }

  for (const fileName of [...new Set(candidates)]) {
    const real = safeExistingFile(path.join(attachmentsDir, fileName), attachmentsDir);
    if (real) return real;
  }
  return null;
}

function bytesFromAttachment(attachment) {
  for (const value of [attachment.bytes, attachment.data]) {
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value);
    if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) return Buffer.from(value);
  }
  return null;
}

function attachmentName(attachment, sourcePath, extension, index) {
  const declared = typeof attachment.name === "string" ? attachment.name.trim() : "";
  const fromSource = sourcePath ? path.basename(sourcePath).trim() : "";
  const fallback = `attachment-${index}${extension}`;
  const name = (declared || fromSource || fallback).slice(0, MAX_ATTACHMENT_NAME_LENGTH).trim();
  return name || fallback;
}

function canonicalAttachment(attachment, type, sourcePath, sizeBytes, index) {
  const declaredMimeType = typeof attachment.mimeType === "string" ? attachment.mimeType.trim() : "";
  if (declaredMimeType.length > MAX_MIME_TYPE_LENGTH) {
    return { error: `mimeType must be at most ${MAX_MIME_TYPE_LENGTH} characters` };
  }
  if (type === "image" && declaredMimeType && !/^image\//i.test(declaredMimeType)) {
    return { error: "image attachment mimeType must start with image/" };
  }

  const preliminaryExtension = attachmentExtension(type, declaredMimeType, attachment.name, sourcePath);
  const name = attachmentName(attachment, sourcePath, preliminaryExtension, index);
  const mimeType = (declaredMimeType || mimeTypeForExtension(type, preliminaryExtension)).toLowerCase();
  if (!mimeType || mimeType.length > MAX_MIME_TYPE_LENGTH) {
    return { error: `mimeType must be between 1 and ${MAX_MIME_TYPE_LENGTH} characters` };
  }
  const extension = attachmentExtension(type, mimeType, name, sourcePath);
  const canonical = {
    type,
    id: `import-${crypto.randomUUID()}-${extension.slice(1) || "bin"}`,
    name,
    mimeType,
    sizeBytes,
  };
  return { canonical, extension };
}

function prepareAttachments({ ir, targetDbPath }) {
  if (!ir || !Array.isArray(ir.messages)) throw new TypeError("prepareAttachments requires ir.messages");
  if (typeof targetDbPath !== "string" || !targetDbPath) {
    throw new TypeError("prepareAttachments requires targetDbPath");
  }

  const sourceDbPath = ir.source?.harness === "t3" && typeof ir.source.sourcePath === "string"
    ? ir.source.sourcePath
    : null;
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "threadbridge-t3-attachments-"));
  const messages = ir.messages.map((message) => ({
    ...message,
    attachments: [],
  }));
  const warnings = [];
  const staged = [];
  const published = new Map();
  const targetDir = path.join(path.dirname(path.resolve(targetDbPath)), "attachments");
  let cleaned = false;

  function addWarning(code, message, messageIndex, attachmentIndex, attachmentId = null) {
    warnings.push(warning(code, message, { messageIndex, attachmentIndex, attachmentId }));
  }

  try {
    for (let messageIndex = 0; messageIndex < ir.messages.length; messageIndex += 1) {
      const inputMessage = ir.messages[messageIndex];
      const inputAttachments = Array.isArray(inputMessage.attachments) ? inputMessage.attachments : [];
      const kept = [];
      for (let attachmentIndex = 0; attachmentIndex < inputAttachments.length; attachmentIndex += 1) {
        const input = inputAttachments[attachmentIndex];
        const type = input && typeof input.type === "string" ? input.type : "unknown";
        const attachmentId = input && typeof input.id === "string" ? input.id : null;
        if (!input || typeof input !== "object" || (type !== "image" && type !== "file")) {
          addWarning(
            "attachment_unsupported",
            `Attachment ${messageIndex}:${attachmentIndex} has unsupported type ${type}.`,
            messageIndex,
            attachmentIndex,
            attachmentId,
          );
          continue;
        }

        const inlineBytes = bytesFromAttachment(input);
        const localPath = inlineBytes === null ? resolveLocalPath(input, ir, sourceDbPath) : null;
        const sourcePath = inlineBytes === null
          ? localPath || resolveT3Path(input, sourceDbPath)
          : null;
        if (inlineBytes === null && !sourcePath) {
          const reason = attachmentId && !stockAttachmentId(attachmentId)
            ? "invalid attachment id"
            : "file bytes were not found in the source attachment store";
          addWarning(
            "attachment_missing",
            `Attachment ${messageIndex}:${attachmentIndex} was not transferred: ${reason}.`,
            messageIndex,
            attachmentIndex,
            attachmentId,
          );
          continue;
        }

        let bytes;
        try {
          bytes = inlineBytes === null ? fs.readFileSync(sourcePath) : inlineBytes;
        } catch (error) {
          addWarning(
            "attachment_unreadable",
            `Attachment ${messageIndex}:${attachmentIndex} was not transferred: ${error.message}.`,
            messageIndex,
            attachmentIndex,
            attachmentId,
          );
          continue;
        }

        const metadata = canonicalAttachment(input, type, sourcePath, bytes.length, attachmentIndex);
        if (metadata.error) {
          addWarning(
            "attachment_invalid",
            `Attachment ${messageIndex}:${attachmentIndex} was not transferred: ${metadata.error}.`,
            messageIndex,
            attachmentIndex,
            attachmentId,
          );
          continue;
        }
        const maximumBytes = type === "image" ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
        if (bytes.length > maximumBytes || (type === "file" && bytes.length < 1)) {
          const reason = type === "file" && bytes.length < 1
            ? "file attachments must not be empty"
            : `attachment exceeds the ${maximumBytes} byte limit`;
          addWarning(
            "attachment_invalid",
            `Attachment ${messageIndex}:${attachmentIndex} was not transferred: ${reason}.`,
            messageIndex,
            attachmentIndex,
            attachmentId,
          );
          continue;
        }

        const stagedPath = path.join(stagingDir, `${staged.length}${metadata.extension}`);
        try {
          fs.writeFileSync(stagedPath, bytes, { flag: "wx" });
        } catch (error) {
          addWarning(
            "attachment_unreadable",
            `Attachment ${messageIndex}:${attachmentIndex} was not transferred: ${error.message}.`,
            messageIndex,
            attachmentIndex,
            attachmentId,
          );
          continue;
        }

        if (input.source !== undefined) {
          addWarning("attachment_source_omitted", "Attachment capture metadata was omitted from the portable copy.", messageIndex, attachmentIndex, attachmentId);
        }
        const targetPath = path.join(targetDir, `${metadata.canonical.id}${metadata.extension}`);
        kept.push(metadata.canonical);
        messages[messageIndex].attachments = kept;
        staged.push({
          stagedPath,
          targetPath,
          attachment: metadata.canonical,
          extension: metadata.extension,
        });
      }
      messages[messageIndex].attachments = kept;
    }
  } catch (error) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }

  function ensureTargetDirectory() {
    const existing = lstatOrNull(targetDir);
    if (existing && existing.isSymbolicLink()) {
      throw new Error(`T3 attachment target directory must not be a symlink: ${targetDir}`);
    }
    if (!existing) fs.mkdirSync(targetDir, { recursive: true });
    const stat = lstatOrNull(targetDir);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`T3 attachment target directory is not a safe directory: ${targetDir}`);
    }
    const targetParent = path.dirname(targetDir);
    if (!realPathInside(targetDir, targetParent)) {
      throw new Error(`T3 attachment target directory escapes its target database directory: ${targetDir}`);
    }
  }

  function samePublishedFile(filePath, identity) {
    const stat = lstatOrNull(filePath);
    return Boolean(
      stat &&
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.dev === identity.dev &&
      stat.ino === identity.ino,
    );
  }

  function publish() {
    if (cleaned) throw new Error("Cannot publish attachments after cleanup");
    if (!staged.length) return { files: [] };
    ensureTargetDirectory();
    for (const token of staged) {
      const prior = published.get(token.targetPath);
      if (prior && samePublishedFile(token.targetPath, prior)) continue;
      try {
        fs.copyFileSync(token.stagedPath, token.targetPath, fs.constants.COPYFILE_EXCL);
      } catch (error) {
        // EEXIST is intentional: IDs are already part of the caller's events
        // and must never be regenerated or silently overwritten.
        throw error;
      }
      const stat = lstatOrNull(token.targetPath);
      if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Published T3 attachment is not a regular file: ${token.targetPath}`);
      }
      published.set(token.targetPath, { dev: stat.dev, ino: stat.ino });
    }
    return { files: [...published.keys()] };
  }

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }

  function rollback() {
    for (const [filePath, identity] of published) {
      if (!realPathInside(targetDir, path.dirname(targetDir))) {
        warnings.push(warning("attachment_rollback_failed", `Could not remove ${filePath}: target directory is unsafe.`));
        continue;
      }
      const stat = lstatOrNull(filePath);
      if (!stat) {
        published.delete(filePath);
        continue;
      }
      if (!samePublishedFile(filePath, identity)) {
        warnings.push(warning("attachment_rollback_skipped", `Did not remove changed attachment ${filePath}.`));
        continue;
      }
      try {
        fs.unlinkSync(filePath);
        published.delete(filePath);
      } catch (error) {
        if (error.code !== "ENOENT") {
          warnings.push(warning("attachment_rollback_failed", `Could not remove ${filePath}: ${error.message}.`));
        } else {
          published.delete(filePath);
        }
      }
    }
    // Keep staged bytes and IDs for a database lock retry. The caller owns
    // final cleanup after either commit or terminal failure.
  }

  return {
    messages,
    warnings,
    count: staged.length,
    publish,
    rollback,
    cleanup,
  };
}

module.exports = { prepareAttachments };
