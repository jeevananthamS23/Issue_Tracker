
import axios from "axios";

// Create axios instance with base URL
const API = axios.create({
  baseURL: "https://issue-tracker-frnb.onrender.com/api",
  headers: {
    "Content-Type": "application/json",
  },
});

// Add request interceptor to include auth token in requests
API.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem("token");
    if (token) {
      config.headers["Authorization"] = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Add response interceptor to handle authentication errors
API.interceptors.response.use(
  (response) => {
    return response;
  },
  (error) => {
    // Handle 401 Unauthorized errors (expired or invalid token)
    if (error.response && error.response.status === 401) {
      localStorage.removeItem("token");
      // Redirect to login page
      window.location.href = "/auth";
    }
    return Promise.reject(error);
  }
);

// Authentication helper functions
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

// Vote service functions
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

// Export the API instance and additional services
export { Auth, VoteService };
export default API;