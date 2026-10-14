const express = require("express");
const router = express.Router();
const { registerUser, loginUser, getUserProfile } = require("../controllers/userAuth.controller");
const { authenticateToken } = require("../middleware/authenticateToken");

router.post("/signup", registerUser);
router.post("/login", loginUser);
router.get("/profile", authenticateToken, getUserProfile);

module.exports = router;
