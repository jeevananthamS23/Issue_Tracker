const mongoose = require("mongoose");

const issueSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  type: { type: String, required: true },
  description: { type: String, required: true },
  imageUrl: { type: String }, // URL for uploaded image
  department: { type: String },
  internalNotes: { type: String }, // Add this field
  location: {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true }
  },
  status: {
    type: String,
    enum: ["reported", "in-progress", "resolved"],
    default: "reported"
  },
  votes: { type: Number, default: 0 },
}, { timestamps: true });


module.exports = mongoose.model("Issue", issueSchema);
