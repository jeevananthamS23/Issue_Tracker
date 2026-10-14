const express = require("express");
const router = express.Router();
const { registerAdmin, loginAdmin, getAdminProfile } = require("../controllers/adminAuth.controller");
const verifyAdmin = require("../middleware/authenticateTokenAdmin");

router.post("/signup", registerAdmin);
router.post("/login", loginAdmin);
router.get("/profile", verifyAdmin, getAdminProfile);

module.exports = router;
