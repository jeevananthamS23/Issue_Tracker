import axios from "axios";

const RAW_BASE_URL = process.env.REACT_APP_API_URL || "https://issue-tracker-frnb.onrender.com";
const BASE_URL = RAW_BASE_URL.replace(/\/+$/, "");

const API = axios.create({
  baseURL: `${BASE_URL}/api`,
  headers: {
    "Content-Type": "application/json",
  },
  withCredentials: true,
});

// Helper to normalize image URLs (handles absolute Cloudinary URLs and relative backend uploads)
export const getImageUrl = (imageUrl) => {
  if (!imageUrl) return null;
  return imageUrl.startsWith("http") ? imageUrl : `${BASE_URL}${imageUrl}`;
};

// Request interceptor to attach admin JWT
API.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem("adminToken");
    if (token) {
      config.headers["Authorization"] = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// Response interceptor to handle unauthenticated/unauthorized responses
API.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response && (error.response.status === 401 || error.response.status === 403)) {
      // Clear invalid or expired admin session
      localStorage.removeItem("adminToken");
      localStorage.removeItem("adminProfile");

      // Redirect to login if in a browser context and not already on /login
      if (typeof window !== "undefined" && window.location.pathname !== "/login") {
        window.location.href = "/login";
      }
    }
    return Promise.reject(error);
  }
);

export const AdminAuth = {
  getToken() {
    return localStorage.getItem("adminToken");
  },
  setSession(token, profile) {
    if (token) localStorage.setItem("adminToken", token);
    if (profile) localStorage.setItem("adminProfile", JSON.stringify(profile));
  },
  clearSession() {
    localStorage.removeItem("adminToken");
    localStorage.removeItem("adminProfile");
  },
  getStoredProfile() {
    try {
      const data = localStorage.getItem("adminProfile");
      return data ? JSON.parse(data) : null;
    } catch {
      return null;
    }
  },
};

export const fetchHotspots = (params) => API.get("/admin-dashboard/hotspots", { params });
export const fetchHotspotById = (id) => API.get(`/admin-dashboard/hotspots/${id}`);
export const runHotspotRefresh = (options) => API.post("/admin-dashboard/hotspots/run", options);

export const fetchNotifications = (params) => API.get("/admin-dashboard/notifications", { params });
export const fetchUnreadNotificationCount = () => API.get("/admin-dashboard/notifications/unread-count");
export const markNotificationRead = (id) => API.patch(`/admin-dashboard/notifications/${id}/read`);
export const markAllNotificationsRead = () => API.patch("/admin-dashboard/notifications/read-all");
export const retryNotificationEmail = (id) => API.post(`/admin-dashboard/notifications/${id}/retry-email`);

export const fetchAnalytics = (params) => API.get("/admin-dashboard/analytics", { params });

export default API;

