const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/authenticateToken");
const upload = require("../middleware/multer");
const {
  getAllIssues,
  reportIssue,
  getUserIssues,
  getNearbyIssues,
  getDuplicateCandidates
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

module.exports = router;
