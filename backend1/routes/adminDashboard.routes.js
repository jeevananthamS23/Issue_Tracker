const express = require("express");
const router = express.Router();
const {
  getAllIssues,
  getFilteredIssues,
  updateIssueStatus,
  resolveDuplicateReview,
  resolveClassificationReview,
  deleteIssue
} = require("../controllers/adminDashboard.controller");
const verifyAdmin = require("../middleware/authenticateTokenAdmin");

router.get("/issues", verifyAdmin, getAllIssues);
router.get("/issues/filter", verifyAdmin, getFilteredIssues);

router.patch("/issues/:id", verifyAdmin, updateIssueStatus);
router.patch("/issues/:id/review", verifyAdmin, resolveDuplicateReview);
router.patch("/issues/:id/classification-review", verifyAdmin, resolveClassificationReview);

router.delete("/issues/:id", verifyAdmin, deleteIssue);

module.exports = router;