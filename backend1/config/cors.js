// backend1/config/cors.js

function getCorsOrigins(env = process.env) {
  const isProduction = env.NODE_ENV === "production";

  // Configured production origins
  const productionOrigins = [
    env.CITIZEN_FRONTEND_ORIGIN || "https://issue-tracker-kappa-pearl.vercel.app",
    env.ADMIN_FRONTEND_ORIGIN,
  ].filter(Boolean);

  if (isProduction) {
    return productionOrigins;
  }

  // In non-production (development, test), include localhost origins
  return [
    ...productionOrigins,
    "http://localhost:3000",
    "http://localhost:3001",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:3001",
  ];
}

function createCorsOptions(env = process.env) {
  return {
    origin: (origin, callback) => {
      // Allow non-browser requests (e.g. server-to-server, curl, health checks)
      if (!origin) return callback(null, true);

      const allowed = getCorsOrigins(env);
      if (allowed.includes(origin)) {
        return callback(null, true);
      }

      const corsError = new Error(`CORS policy violation: Origin '${origin}' is not permitted.`);
      corsError.code = "CORS_NOT_ALLOWED";
      return callback(corsError, false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"],
  };
}

module.exports = { getCorsOrigins, createCorsOptions };
