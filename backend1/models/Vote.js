// models/Vote.js
const mongoose = require("mongoose");

const voteSchema = new mongoose.Schema({
  userId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: "User", 
    required: true 
  },
  issueId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: "Issue", 
    required: true 
  }
}, { timestamps: true });

// Compound index to ensure one vote per user per issue
voteSchema.index({ userId: 1, issueId: 1 }, { unique: true });

module.exports = mongoose.model("Vote", voteSchema);