const path = require("path");
const multer = require("multer");
const { PassThrough } = require("stream");
const cloudinary = require("../config/cloudinary");

const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const ALLOWED_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

/**
 * Validates binary magic bytes for JPEG, PNG, and WebP images.
 * @param {Buffer} buffer - Initial chunk of the uploaded file.
 * @returns {string|false} Detected MIME type or false if signature does not match.
 */
function validateImageSignature(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 12) {
    return false;
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }

  // WebP: RIFF .... WEBP (bytes 0-3 RIFF, bytes 8-11 WEBP)
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "image/webp";
  }

  return false;
}

/**
 * Custom Multer storage engine that verifies the binary magic signature
 * before piping the file stream to Cloudinary.
 */
class ValidatedCloudinaryStorage {
  constructor(opts) {
    this.cloudinary = opts.cloudinary;
    this.folder = opts.folder || "community-issue-tracker";
  }

  _handleFile(req, file, cb) {
    let checked = false;

    file.stream.once("data", (firstChunk) => {
      checked = true;
      const detectedMime = validateImageSignature(firstChunk);

      if (!detectedMime) {
        const error = new Error("Invalid image content. File binary signature does not match JPEG, PNG, or WebP.");
        error.code = "INVALID_IMAGE_SIGNATURE";
        file.stream.destroy();
        return cb(error);
      }

      // Reconstruct the stream with firstChunk prepended
      const passThrough = new PassThrough();
      passThrough.write(firstChunk);
      file.stream.pipe(passThrough);

      const uploadStream = this.cloudinary.uploader.upload_stream(
        { folder: this.folder },
        (error, result) => {
          if (error) return cb(error);
          cb(null, {
            path: result.secure_url,
            size: result.bytes,
            filename: result.public_id,
          });
        }
      );

      passThrough.pipe(uploadStream);
    });

    file.stream.once("end", () => {
      if (!checked) {
        const error = new Error("Empty upload received.");
        error.code = "INVALID_IMAGE_SIGNATURE";
        return cb(error);
      }
    });

    file.stream.once("error", (err) => {
      cb(err);
    });
  }

  _removeFile(req, file, cb) {
    if (file && file.filename) {
      this.cloudinary.uploader.destroy(file.filename, { invalidate: true }, cb);
    } else {
      cb(null);
    }
  }
}

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const mime = (file.mimetype || "").toLowerCase();

  if (ALLOWED_MIME_TYPES.has(mime) && ALLOWED_EXTENSIONS.has(ext)) {
    cb(null, true);
  } else {
    const error = new Error("Unsupported file type. Only JPEG, PNG, and WebP images are allowed.");
    error.code = "INVALID_FILE_TYPE";
    cb(error, false);
  }
};

const storage = new ValidatedCloudinaryStorage({
  cloudinary,
  folder: "community-issue-tracker",
});

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB maximum
  },
  fileFilter,
});

const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB maximum
  },
  fileFilter,
});

module.exports = upload;
module.exports.upload = upload;
module.exports.uploadMemory = uploadMemory;
module.exports.fileFilter = fileFilter;
module.exports.validateImageSignature = validateImageSignature;
module.exports.ValidatedCloudinaryStorage = ValidatedCloudinaryStorage;

