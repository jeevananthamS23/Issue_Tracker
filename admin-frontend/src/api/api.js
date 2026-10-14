import axios from "axios";

const RAW_BASE_URL = process.env.REACT_APP_API_URL || "http://localhost:5000";
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

export default API;
