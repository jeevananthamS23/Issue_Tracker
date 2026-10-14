const jwt = require("jsonwebtoken");

function verifyAdmin(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.startsWith("Bearer ") ? authHeader.split(" ")[1] : null;

  if (!token) {
    return res.status(401).json({ error: true, message: "Unauthorized: Access token missing" });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(401).json({ error: true, message: "Unauthorized: Invalid or expired token" });
    }

    // Explicit check: reject citizen or non-admin tokens attempting to access admin routes
    if (decoded.role !== "admin" || !decoded.adminId) {
      return res.status(403).json({ error: true, message: "Forbidden: Administrator access required" });
    }

    req.admin = decoded;
    next();
  });
}

module.exports = verifyAdmin;
