import axios from "axios";

const RAW_BASE_URL = process.env.REACT_APP_API_URL || "https://issue-tracker-frnb.onrender.com";
const BASE_URL = RAW_BASE_URL.replace(/\/+$/, "");

const API = axios.create({
  baseURL: `${BASE_URL}/api`,
  headers: {
    "Content-Type": "application/json",
  },
  withCredentials: true // important for CORS compatibility
});

// Cloudinary URLs are already absolute; older issues stored a relative
// "/uploads/..." path served by this backend, so fall back to that.
const getImageUrl = (imageUrl) => {
  if (!imageUrl) return null;
  return imageUrl.startsWith("http") ? imageUrl : `${BASE_URL}${imageUrl}`;
};

// Request interceptor to add auth token
API.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem("token");
    if (token) {
      config.headers["Authorization"] = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// Response interceptor to handle 401 errors
API.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response && error.response.status === 401) {
      localStorage.removeItem("token");
      // Prevent infinite redirect loops if 401 happens on the /auth page itself
      if (typeof window !== "undefined" && window.location.pathname !== "/auth") {
        window.location.href = "/auth";
      }
    }
    return Promise.reject(error);
  }
);

// Auth helper
const Auth = {
  isAuthenticated() {
    return !!localStorage.getItem("token");
  },
  getToken() {
    return localStorage.getItem("token");
  },
  logout() {
    localStorage.removeItem("token");
    window.location.href = "/auth";
  }
};

// Vote service
const VoteService = {
  voteForIssue(issueId) {
    return API.post(`/votes/${issueId}`);
  },
  checkUserVote(issueId) {
    return API.get(`/votes/check/${issueId}`);
  },
  getUserVotedIssues() {
    return API.get('/votes/user');
  }
};

export { Auth, VoteService, getImageUrl };
export default API;
