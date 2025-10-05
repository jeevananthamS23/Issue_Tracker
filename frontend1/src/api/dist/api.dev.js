"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = exports.VoteService = exports.Auth = void 0;

var _axios = _interopRequireDefault(require("axios"));

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }

var API = _axios["default"].create({
  baseURL: "https://issue-tracker-frnb.onrender.com/api",
  // your deployed backend
  headers: {
    "Content-Type": "application/json"
  },
  withCredentials: true // important for auth cookies

}); // Request interceptor to add auth token


API.interceptors.request.use(function (config) {
  var token = localStorage.getItem("token");

  if (token) {
    config.headers["Authorization"] = "Bearer ".concat(token);
  }

  return config;
}, function (error) {
  return Promise.reject(error);
}); // Response interceptor to handle 401 errors

API.interceptors.response.use(function (response) {
  return response;
}, function (error) {
  if (error.response && error.response.status === 401) {
    localStorage.removeItem("token");
    window.location.href = "/auth";
  }

  return Promise.reject(error);
}); // Auth helper

var Auth = {
  isAuthenticated: function isAuthenticated() {
    return !!localStorage.getItem("token");
  },
  getToken: function getToken() {
    return localStorage.getItem("token");
  },
  logout: function logout() {
    localStorage.removeItem("token");
    window.location.href = "/auth";
  }
}; // Vote service

exports.Auth = Auth;
var VoteService = {
  voteForIssue: function voteForIssue(issueId) {
    return API.post("/votes/".concat(issueId));
  },
  checkUserVote: function checkUserVote(issueId) {
    return API.get("/votes/check/".concat(issueId));
  },
  getUserVotedIssues: function getUserVotedIssues() {
    return API.get('/votes/user');
  }
};
exports.VoteService = VoteService;
var _default = API;
exports["default"] = _default;