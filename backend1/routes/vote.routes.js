// routes/vote.routes.js
const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/authenticateToken");
const { 
  voteForIssue, 
  checkUserVote,
  getUserVotedIssues 
} = require("../controllers/vote.controller");

// Vote for an issue (protected route - requires authentication)
router.post("/:issueId", authenticateToken, voteForIssue);

// Check if user has voted for an issue (protected route)
router.get("/check/:issueId", authenticateToken, checkUserVote);

// Get all issues the user has voted for (protected route)
router.get("/user", authenticateToken, getUserVotedIssues);

module.exports = router;