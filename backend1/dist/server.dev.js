"use strict";

require("dotenv").config();

var express = require("express");

var mongoose = require("mongoose");

var cors = require("cors");

var userRoutes = require("./routes/userAuth.routes");

var adminRoutes = require("./routes/adminAuth.routes");

var issueRoutes = require("./routes/issue.routes");

var adminDashboardRoutes = require("./routes/adminDashboard.routes");

var voteRoutes = require("./routes/vote.routes");

var app = express(); // Middleware

app.use(cors({
  origin: "https://issue-tracker-1-lwig.onrender.com",
  // your frontend URL
  credentials: true
}));
app.use(express.json());
app.use("/uploads", express["static"]("uploads")); // Static path for uploaded images
// Database connection

mongoose.connect(process.env.MONGO_URI).then(function () {
  return console.log("MongoDB Connected");
})["catch"](function (err) {
  return console.log("Mongo Error", err);
}); // Routes

app.use("/api/user", userRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/issues", issueRoutes);
app.use("/api/admin-dashboard", adminDashboardRoutes);
app.use("/api/votes", voteRoutes); // Start server

var PORT = process.env.PORT || 5000;
app.listen(PORT, function () {
  return console.log("Server running on port ".concat(PORT));
});