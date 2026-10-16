const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/authenticateToken");
const upload = require("../middleware/multer");
const { uploadMemory } = require("../middleware/multer");
const { ocrRateLimiter } = require("../middleware/rateLimiter");
const {
  getAllIssues,
  reportIssue,
  getUserIssues,
  getNearbyIssues,
  getDuplicateCandidates,
  extractOcrCoordinates
} = require("../controllers/issue.controller");

// Spatial candidate retrieval for duplicate detection (Stage 1)
router.get("/duplicate-candidates", getDuplicateCandidates);

// Spatial query: find nearby issues with radius and filters
router.get("/nearby", getNearbyIssues);

// Public: get all issues
router.get("/", getAllIssues);

// Protected: user's own issues
router.get("/user", authenticateToken, getUserIssues);

// Protected: report a new issue with optional image upload
router.post("/", authenticateToken, upload.single("image"), reportIssue);

// Protected: extract OCR coordinates from image buffer (Phase F5-D)
router.post(
  "/extract-ocr",
  authenticateToken,
  ocrRateLimiter,
  (req, res, next) => {
    uploadMemory.single("image")(req, res, (err) => {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({ error: true, message: "File size exceeds 5MB limit" });
        }
        return res.status(400).json({ error: true, message: err.message });
      }
      if (!req.file) {
        // Fallback for field name 'file'
        return uploadMemory.single("file")(req, res, (err2) => {
          if (err2) {
            if (err2.code === "LIMIT_FILE_SIZE") {
              return res.status(400).json({ error: true, message: "File size exceeds 5MB limit" });
            }
            return res.status(400).json({ error: true, message: err2.message });
          }
          next();
        });
      }
      next();
    });
  },
  extractOcrCoordinates
);

module.exports = router;
