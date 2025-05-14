const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/authenticateToken");
const upload = require("../middleware/multer");
const {
  getAllIssues,
  reportIssue,
  getUserIssues,
 
} = require("../controllers/issue.controller");

// Public: get all issues
router.get("/", getAllIssues);

// Protected: user's own issues
router.get("/user", authenticateToken, getUserIssues);

// Protected: report a new issue with optional image upload
router.post("/", authenticateToken, upload.single("image"), reportIssue);

module.exports = router;
