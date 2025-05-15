const express = require("express");
const router = express.Router();
const {
  getAllIssues,
  getFilteredIssues,
  updateIssueStatus,
  deleteIssue
} = require("../controllers/adminDashboard.controller");
const verifyAdmin = require("../middleware/authenticateTokenAdmin");


router.get("/issues", verifyAdmin, getAllIssues);
router.get("/issues/filter", verifyAdmin, getFilteredIssues); // e.g., /issues/filter?status=resolved&type=pothole
// adminDashboard.router.js

router.patch("/issues/:id", verifyAdmin, updateIssueStatus);

router.delete("/issues/:id", verifyAdmin, deleteIssue);

module.exports = router;