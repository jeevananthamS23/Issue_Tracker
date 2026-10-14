const jwt = require("jsonwebtoken");

function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.startsWith("Bearer ") ? authHeader.split(" ")[1] : null;

  if (!token) {
    return res.status(401).json({ error: true, message: "Unauthorized: Access token missing" });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(401).json({ error: true, message: "Unauthorized: Invalid or expired token" });
    }

    // Explicit check: reject admin tokens attempting to access citizen routes
    if (decoded.role === "admin") {
      return res.status(403).json({ error: true, message: "Forbidden: Citizen access required" });
    }

    // Require valid citizen role and userId
    if (decoded.role !== "citizen" || !decoded.userId) {
      return res.status(401).json({ error: true, message: "Unauthorized: Invalid session token. Please sign in again." });
    }

    req.user = decoded;
    next();
  });
}

module.exports = { authenticateToken };
