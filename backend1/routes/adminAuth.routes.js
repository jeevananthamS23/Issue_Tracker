const express = require("express");
const router = express.Router();
const { registerAdmin, loginAdmin } = require("../controllers/adminAuth.controller");

router.post("/signup", registerAdmin);
router.post("/login", loginAdmin);

module.exports = router;
