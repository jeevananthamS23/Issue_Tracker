const express = require("express");
const router = express.Router();
const {
  getAllIssues,
  getFilteredIssues,
  updateIssueStatus,
  resolveDuplicateReview,
  resolveClassificationReview,
  deleteIssue,
  getHotspots,
  getHotspotById,
  runHotspotRefresh,
  getNotifications,
  getUnreadNotificationCount,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  retryNotificationEmail,
  getAnalytics
} = require("../controllers/adminDashboard.controller");
const verifyAdmin = require("../middleware/authenticateTokenAdmin");

// Protected Analytics Endpoint (Sprint Block 2)
router.get("/analytics", verifyAdmin, getAnalytics);

router.get("/issues", verifyAdmin, getAllIssues);
router.get("/issues/filter", verifyAdmin, getFilteredIssues);

router.patch("/issues/:id", verifyAdmin, updateIssueStatus);
router.patch("/issues/:id/review", verifyAdmin, resolveDuplicateReview);
router.patch("/issues/:id/classification-review", verifyAdmin, resolveClassificationReview);

router.delete("/issues/:id", verifyAdmin, deleteIssue);

// Protected Hotspot Endpoints (Phase 4.2B-C)
router.get("/hotspots", verifyAdmin, getHotspots);
router.get("/hotspots/:id", verifyAdmin, getHotspotById);
router.post("/hotspots/run", verifyAdmin, runHotspotRefresh);

// Protected Admin Notification Endpoints (Phase 4.2C-A)
router.get("/notifications", verifyAdmin, getNotifications);
router.get("/notifications/unread-count", verifyAdmin, getUnreadNotificationCount);
router.patch("/notifications/read-all", verifyAdmin, markAllNotificationsAsRead);
router.patch("/notifications/:id/read", verifyAdmin, markNotificationAsRead);
router.post("/notifications/:id/retry-email", verifyAdmin, retryNotificationEmail);

module.exports = router;