import axios from "axios";

const API = axios.create({
  baseURL: "https://issue-tracker-frnb.onrender.com/api", // your deployed backend
  headers: {
    "Content-Type": "application/json",
  },
  withCredentials: true // important for auth cookies
});

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
      window.location.href = "/auth";
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

export { Auth, VoteService };
export default API;
