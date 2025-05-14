// controllers/vote.controller.js
const Issue = require("../models/Issue");
const Vote = require("../models/Vote");

exports.voteForIssue = async (req, res) => {
  try {
    const { issueId } = req.params;
    const userId = req.user.userId;

    // Check if issue exists
    const issue = await Issue.findById(issueId);
    if (!issue) {
      return res.status(404).json({ 
        success: false, 
        message: "Issue not found" 
      });
    }

    // Check if user has already voted for this issue
    const existingVote = await Vote.findOne({ userId, issueId });
    if (existingVote) {
      return res.status(400).json({ 
        success: false, 
        message: "You have already voted for this issue" 
      });
    }

    // Create new vote
    const newVote = new Vote({ userId, issueId });
    await newVote.save();

    // Increment the vote count on the issue
    issue.votes += 1;
    await issue.save();

    return res.status(200).json({ 
      success: true, 
      message: "Vote recorded successfully", 
      votes: issue.votes 
    });
  } catch (err) {
    console.error("Vote error:", err);
    return res.status(500).json({ 
      success: false, 
      message: "Failed to record vote" 
    });
  }
};

exports.checkUserVote = async (req, res) => {
  try {
    const { issueId } = req.params;
    const userId = req.user.userId;

    const vote = await Vote.findOne({ userId, issueId });
    
    return res.status(200).json({ 
      hasVoted: !!vote 
    });
  } catch (err) {
    console.error("Check vote error:", err);
    return res.status(500).json({ 
      success: false, 
      message: "Failed to check vote status" 
    });
  }
};

exports.getUserVotedIssues = async (req, res) => {
  try {
    const userId = req.user.userId;
    
    const votes = await Vote.find({ userId });
    const votedIssueIds = votes.map(vote => vote.issueId);
    
    return res.status(200).json({ 
      success: true, 
      votedIssueIds 
    });
  } catch (err) {
    console.error("Get voted issues error:", err);
    return res.status(500).json({ 
      success: false, 
      message: "Failed to get voted issues" 
    });
  }
};