import React, { useState, useEffect, useCallback } from "react";
import { useAdminAuth } from "../context/AdminAuthContext";
import API, { getImageUrl, fetchUnreadNotificationCount, fetchAnalytics } from "../api/api";
import {
  ShieldCheck,
  LogOut,
  RefreshCw,
  Search,
  Filter,
  CheckCircle2,
  Clock,
  AlertTriangle,
  MapPin,
  User,
  Mail,
  Calendar,
  ThumbsUp,
  X,
  ExternalLink,
  Trash2,
  Save,
  Building2,
  FileText,
  Layers,
  HelpCircle,
  Flame,
  Bell,
  BarChart3,
  TrendingUp
} from "lucide-react";
import HotspotsSection from "../components/HotspotsSection";
import NotificationCenter from "../components/NotificationCenter";
import AnalyticsSection from "../components/AnalyticsSection";
import "./Dashboard.css";

const DEPARTMENTS = [
  "Roads & Infrastructure",
  "Public Works",
  "Waste Management",
  "Street Lighting",
  "Parks & Recreation",
  "Water Services",
  "Environmental Services",
  "Urban Planning"
];

const ISSUE_TYPES = [
  "all",
  "pothole",
  "garbage",
  "street light",
  "water leak",
  "road damage",
  "traffic signal",
  "other"
];

const REVIEW_STATUS_OPTIONS = [
  { value: "all", label: "All Review States" },
  { value: "needs_review", label: "Needs Review (Any)" },
  { value: "needs_duplicate", label: "Needs Duplicate Review" },
  { value: "needs_classification", label: "Needs Triage Review" },
  { value: "flagged_duplicate", label: "Flagged Duplicates" },
  { value: "unverified", label: "Unverified AI" },
  { value: "confirmed_duplicate", label: "Confirmed Duplicates" },
  { value: "dismissed_unique", label: "Dismissed (Unique)" }
];

/**
 * Resolves severity score out of 10 into Low, Medium, and High bands.
 * Explicitly distinguishes rule-based heuristic score from neural confidence.
 */
function getSeverityBadgeInfo(severity) {
  if (severity === null || severity === undefined || typeof severity !== "number" || isNaN(severity)) {
    return {
      band: "unavailable",
      label: "N/A",
      scoreFormatted: "—",
      pillClass: "severity-pill-unavailable",
      tooltip: "Severity score unavailable (unprocessed or photo missing)"
    };
  }

  const score = Math.min(10, Math.max(1, severity));
  const scoreFormatted = `${score.toFixed(1)}/10`;

  if (score >= 7.0) {
    return {
      band: "high",
      label: "High",
      scoreFormatted,
      pillClass: "severity-pill-high",
      tooltip: `Severity: ${scoreFormatted} (High band) — Rule-based heuristic estimate`
    };
  } else if (score >= 4.0) {
    return {
      band: "medium",
      label: "Medium",
      scoreFormatted,
      pillClass: "severity-pill-medium",
      tooltip: `Severity: ${scoreFormatted} (Medium band) — Rule-based heuristic estimate`
    };
  } else {
    return {
      band: "low",
      label: "Low",
      scoreFormatted,
      pillClass: "severity-pill-low",
      tooltip: `Severity: ${scoreFormatted} (Low band) — Rule-based heuristic estimate`
    };
  }
}

/**
 * Calculates geodesic distance in meters between two location objects.
 */
function calculateDistanceMeters(locA, locB) {
  if (!locA || !locB) return null;
  const lat1 = locA.lat !== undefined ? Number(locA.lat) : (Array.isArray(locA.coordinates) ? Number(locA.coordinates[1]) : null);
  const lon1 = locA.lng !== undefined ? Number(locA.lng) : (Array.isArray(locA.coordinates) ? Number(locA.coordinates[0]) : null);
  const lat2 = locB.lat !== undefined ? Number(locB.lat) : (Array.isArray(locB.coordinates) ? Number(locB.coordinates[1]) : null);
  const lon2 = locB.lng !== undefined ? Number(locB.lng) : (Array.isArray(locB.coordinates) ? Number(locB.coordinates[0]) : null);

  if (lat1 === null || lon1 === null || lat2 === null || lon2 === null || isNaN(lat1) || isNaN(lon1) || isNaN(lat2) || isNaN(lon2)) {
    return null;
  }

  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

const Dashboard = () => {
  const { admin, logout } = useAdminAuth();

  const [issues, setIssues] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  // Filters state
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState("all"); // "all" | "needs_review" | "reported" | "in-progress" | "resolved"
  const [statusFilter, setStatusFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [departmentFilter, setDepartmentFilter] = useState("all");
  const [reviewFilter, setReviewFilter] = useState("all");

  // Selected issue for detail drawer / modal
  const [selectedIssue, setSelectedIssue] = useState(null);
  const [updating, setUpdating] = useState(false);
  const [updateMessage, setUpdateMessage] = useState(null);
  const [updateForm, setUpdateForm] = useState({
    status: "reported",
    department: "",
    internalNotes: ""
  });

  // Duplicate Comparison & Resolution Modal State
  const [comparisonIssue, setComparisonIssue] = useState(null);
  const [reviewNotes, setReviewNotes] = useState("");
  const [submittingReview, setSubmittingReview] = useState(false);
  const [reviewMessage, setReviewMessage] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState(null); // { action: "confirm_duplicate" | "dismiss_duplicate" } | null

  // Delete confirmation modal
  const [issueToDelete, setIssueToDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);

  // Notification unread count and hotspot target state
  const [unreadNotificationsCount, setUnreadNotificationsCount] = useState(0);
  const [targetHotspotId, setTargetHotspotId] = useState(null);

  const fetchUnreadCount = useCallback(async () => {
    try {
      const res = await fetchUnreadNotificationCount();
      if (typeof res.data?.unreadCount === "number") {
        setUnreadNotificationsCount(res.data.unreadCount);
      }
    } catch (err) {
      console.error("Error fetching unread notification count:", err);
    }
  }, []);

  useEffect(() => {
    fetchUnreadCount();
    // Periodically poll unread count every 30 seconds while dashboard is open
    const interval = setInterval(() => {
      fetchUnreadCount();
    }, 30000);
    return () => clearInterval(interval);
  }, [fetchUnreadCount]);

  const handleNavigateToHotspot = (hotspotId) => {
    setTargetHotspotId(hotspotId);
    setActiveTab("hotspots");
  };

  // Fetch all issues via protected admin endpoint
  const fetchIssues = useCallback(async () => {
    try {
      setError(null);
      const res = await API.get("/admin-dashboard/issues");
      setIssues(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      console.error("Error fetching admin issues:", err);
      setError(
        err.response?.data?.message ||
        "Failed to load issues from server. Please verify backend service and authentication."
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Performance Analytics State (Sprint Block 2)
  const [analytics, setAnalytics] = useState(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [analyticsError, setAnalyticsError] = useState(null);
  const [analyticsDays, setAnalyticsDays] = useState(30);

  const fetchAnalyticsData = useCallback(async (days = 30) => {
    try {
      setAnalyticsLoading(true);
      setAnalyticsError(null);
      const res = await fetchAnalytics({ days });
      if (res && res.data && res.data.data) {
        setAnalytics(res.data.data);
      }
    } catch (err) {
      // Soft failure: do not disrupt primary issue management if analytics fails
      setAnalyticsError(
        err.response?.data?.message || "Failed to load database analytics."
      );
    } finally {
      setAnalyticsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchIssues();
    fetchAnalyticsData(analyticsDays);
  }, [fetchIssues, fetchAnalyticsData, analyticsDays]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchIssues();
    fetchUnreadCount();
    fetchAnalyticsData(analyticsDays);
  };


  // Open detail modal and sync form fields
  const handleOpenDetail = (issue) => {
    setSelectedIssue(issue);
    setUpdateMessage(null);
    setUpdateForm({
      status: issue.status || "reported",
      department: issue.department || "",
      internalNotes: issue.internalNotes || ""
    });
  };

  const handleCloseDetail = () => {
    setSelectedIssue(null);
    setUpdateMessage(null);
  };

  // Handle issue status and department update
  const handleUpdateSubmit = async (e) => {
    e.preventDefault();
    if (!selectedIssue) return;

    setUpdating(true);
    setUpdateMessage(null);

    try {
      const res = await API.patch(`/admin-dashboard/issues/${selectedIssue._id}`, {
        status: updateForm.status,
        department: updateForm.department,
        internalNotes: updateForm.internalNotes
      });

      const updated = res.data;
      const merged = {
        ...selectedIssue,
        ...updated,
        userId: selectedIssue.userId,
        duplicateOf: selectedIssue.duplicateOf
      };

      setIssues((prev) => prev.map((item) => (item._id === merged._id ? merged : item)));
      setSelectedIssue(merged);
      setUpdateMessage({ type: "success", text: "Issue status updated successfully." });
    } catch (err) {
      setUpdateMessage({
        type: "error",
        text: err.response?.data?.message || "Failed to update issue. Please try again."
      });
    } finally {
      setUpdating(false);
    }
  };

  // Handle issue deletion
  const handleConfirmDelete = async () => {
    if (!issueToDelete) return;
    setDeleting(true);

    try {
      await API.delete(`/admin-dashboard/issues/${issueToDelete._id}`);
      setIssues((prev) => prev.filter((i) => i._id !== issueToDelete._id));
      if (selectedIssue && selectedIssue._id === issueToDelete._id) {
        setSelectedIssue(null);
      }
      if (comparisonIssue && comparisonIssue._id === issueToDelete._id) {
        setComparisonIssue(null);
      }
      setIssueToDelete(null);
    } catch (err) {
      alert(err.response?.data?.message || "Failed to delete issue.");
    } finally {
      setDeleting(false);
    }
  };

  // Open comparison modal
  const handleOpenComparison = (issue) => {
    setComparisonIssue(issue);
    setReviewNotes(issue.reviewNotes || "");
    setReviewMessage(null);
    setConfirmDialog(null);
  };

  const handleCloseComparison = () => {
    setComparisonIssue(null);
    setReviewMessage(null);
    setConfirmDialog(null);
  };

  const handleRequestReviewAction = (action) => {
    setReviewMessage(null);
    setConfirmDialog({ action });
  };

  const handleCancelConfirm = () => {
    setConfirmDialog(null);
  };

  // Execute review resolution action against backend endpoint
  const handleExecuteReviewAction = async () => {
    if (!comparisonIssue || !confirmDialog) return;
    setSubmittingReview(true);
    setReviewMessage(null);

    try {
      const res = await API.patch(`/admin-dashboard/issues/${comparisonIssue._id}/review`, {
        action: confirmDialog.action,
        reviewNotes: reviewNotes.trim()
      });

      const updated = res.data.issue;
      // In-place state updates
      setIssues((prev) => prev.map((item) => (item._id === updated._id ? updated : item)));
      setComparisonIssue(updated);
      if (selectedIssue && selectedIssue._id === updated._id) {
        setSelectedIssue(updated);
      }
      setConfirmDialog(null);

      const actionTitle =
        confirmDialog.action === "confirm_duplicate" ? "Confirmed Duplicate" : "Dismissed as Unique";
      setReviewMessage({
        type: "success",
        text: res.data?.message || `Duplicate review successfully resolved as '${actionTitle}'.`
      });
    } catch (err) {
      setReviewMessage({
        type: "error",
        text: err.response?.data?.message || "Failed to submit review resolution. Please try again."
      });
    } finally {
      setSubmittingReview(false);
    }
  };

  // Filter issues based on tabs, dropdowns, and search query
  const filteredIssues = issues.filter((issue) => {
    // Top Tabs filter
    if (activeTab === "needs_review" && !issue.needsReview) return false;
    if (activeTab === "reported" && issue.status !== "reported") return false;
    if (activeTab === "in-progress" && issue.status !== "in-progress") return false;
    if (activeTab === "resolved" && issue.status !== "resolved") return false;

    // Dropdown status filter
    if (statusFilter !== "all" && issue.status !== statusFilter) return false;

    // Dropdown type filter
    if (typeFilter !== "all" && issue.type?.toLowerCase() !== typeFilter.toLowerCase()) return false;

    // Dropdown department filter
    if (departmentFilter !== "all" && issue.department !== departmentFilter) return false;

    // Dropdown review filter
    if (reviewFilter === "needs_review" && !issue.needsReview) return false;
    if (reviewFilter === "needs_duplicate" && !issue.needsDuplicateReview) return false;
    if (reviewFilter === "needs_classification" && !issue.needsClassificationReview) return false;
    if (reviewFilter === "flagged_duplicate" && issue.duplicateStatus !== "flagged_duplicate") return false;
    if (reviewFilter === "unverified" && issue.duplicateStatus !== "unverified") return false;
    if (reviewFilter === "confirmed_duplicate" && issue.reviewResolution !== "confirmed_duplicate") return false;
    if (reviewFilter === "dismissed_unique" && issue.reviewResolution !== "dismissed_unique") return false;

    // Search query filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const descMatch = issue.description?.toLowerCase().includes(q);
      const typeMatch = issue.type?.toLowerCase().includes(q);
      const idMatch = issue._id?.toLowerCase().includes(q);
      const dupId = typeof issue.duplicateOf === "string" ? issue.duplicateOf : issue.duplicateOf?._id;
      const dupMatch = dupId ? dupId.toLowerCase().includes(q) : false;
      const reporterMatch =
        issue.userId?.fullName?.toLowerCase().includes(q) ||
        issue.userId?.email?.toLowerCase().includes(q);
      return descMatch || typeMatch || idMatch || dupMatch || reporterMatch;
    }

    return true;
  });

  // Metric counts (derived from database-backed analytics aggregation when available)
  const totalCount = analytics?.summary?.totalIssues ?? issues.length;
  const needsReviewCount = analytics?.summary?.needsReviewIssues ?? issues.filter((i) => i.needsReview).length;
  const flaggedDupCount = issues.filter((i) => i.duplicateStatus === "flagged_duplicate").length;
  const reportedCount = analytics?.summary?.reportedIssues ?? issues.filter((i) => i.status === "reported").length;
  const inProgressCount = analytics?.summary?.inProgressIssues ?? issues.filter((i) => i.status === "in-progress").length;
  const resolvedCount = analytics?.summary?.resolvedIssues ?? issues.filter((i) => i.status === "resolved").length;

  return (
    <div className="admin-portal-layout">
      {/* Top Navbar */}
      <header className="admin-navbar">
        <div className="navbar-left">
          <div className="navbar-brand">
            <ShieldCheck size={26} className="brand-shield" />
            <span className="brand-title">CivicVision AI</span>
            <span className="badge-admin">Admin Portal</span>
          </div>
        </div>

        <div className="navbar-right">
          <button
            type="button"
            onClick={() => setActiveTab("notifications")}
            className={`btn-notification-bell ${activeTab === "notifications" ? "active" : ""}`}
            title="Admin Notifications"
            aria-label="Admin Notifications"
            data-testid="btn-notification-bell"
          >
            <Bell size={18} />
            {unreadNotificationsCount > 0 && (
              <span className="bell-badge" data-testid="bell-unread-badge">
                {unreadNotificationsCount > 99 ? "99+" : unreadNotificationsCount}
              </span>
            )}
          </button>

          <div className="admin-profile-pill">
            <User size={16} className="pill-icon" />
            <div className="pill-text">
              <span className="admin-name">{admin?.fullName || "Administrator"}</span>
              <span className="admin-email">{admin?.email || "admin@civicvision.gov"}</span>
            </div>
          </div>

          <button
            onClick={handleRefresh}
            className={`btn-icon ${refreshing ? "spinning" : ""}`}
            title="Refresh issues list"
            aria-label="Refresh data"
          >
            <RefreshCw size={18} />
          </button>

          <button onClick={logout} className="btn-logout" title="Log out of admin portal">
            <LogOut size={16} />
            <span>Sign Out</span>
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="admin-main">
        {/* Metric Cards (Database-backed calculations) */}
        {activeTab !== "hotspots" && activeTab !== "notifications" && activeTab !== "analytics" && (
          <section className="metrics-grid">
            <div
              className={`metric-card total ${activeTab === "all" ? "active-card" : ""}`}
              onClick={() => setActiveTab("all")}
              role="button"
              tabIndex={0}
              title="Filter all issues"
            >
              <div className="metric-header">
                <span className="metric-label">Total Issues</span>
                <FileText size={20} className="metric-icon" />
              </div>
              <div className="metric-value">{totalCount}</div>
              <span className="metric-hint">All reported civic issues</span>
            </div>

            <div
              className={`metric-card needs-review ${activeTab === "needs_review" ? "active-card" : ""}`}
              onClick={() => {
                setActiveTab("needs_review");
                setReviewFilter("needs_review");
              }}
              role="button"
              tabIndex={0}
              title="Filter issues requiring duplicate moderation"
            >
              <div className="metric-header">
                <span className="metric-label">Needs Review</span>
                <Layers size={20} className="metric-icon alert-icon-color" />
              </div>
              <div className="metric-value">{needsReviewCount}</div>
              <span className="metric-hint">
                {flaggedDupCount} flagged duplicate{flaggedDupCount === 1 ? "" : "s"}
              </span>
            </div>

            <div
              className={`metric-card reported ${activeTab === "reported" ? "active-card" : ""}`}
              onClick={() => setActiveTab("reported")}
              role="button"
              tabIndex={0}
              title="Filter reported issues"
            >
              <div className="metric-header">
                <span className="metric-label">Reported</span>
                <AlertTriangle size={20} className="metric-icon" />
              </div>
              <div className="metric-value">{reportedCount}</div>
              <span className="metric-hint">Awaiting review & triage</span>
            </div>

            <div
              className={`metric-card in-progress ${activeTab === "in-progress" ? "active-card" : ""}`}
              onClick={() => setActiveTab("in-progress")}
              role="button"
              tabIndex={0}
              title="Filter in-progress issues"
            >
              <div className="metric-header">
                <span className="metric-label">In Progress</span>
                <Clock size={20} className="metric-icon" />
              </div>
              <div className="metric-value">{inProgressCount}</div>
              <span className="metric-hint">Active municipal remediation</span>
            </div>

            <div
              className={`metric-card resolved ${activeTab === "resolved" ? "active-card" : ""}`}
              onClick={() => setActiveTab("resolved")}
              role="button"
              tabIndex={0}
              title="Filter resolved issues"
            >
              <div className="metric-header">
                <span className="metric-label">Resolved</span>
                <CheckCircle2 size={20} className="metric-icon" />
              </div>
              <div className="metric-value">{resolvedCount}</div>
              <span className="metric-hint">Successfully completed</span>
            </div>

            <div
              className="metric-card rate"
              onClick={() => setActiveTab("analytics")}
              role="button"
              tabIndex={0}
              title="View performance analytics and resolution rate"
            >
              <div className="metric-header">
                <span className="metric-label">Resolution Rate</span>
                <TrendingUp size={20} className="metric-icon icon-accent" />
              </div>
              <div className="metric-value">{analytics?.summary?.resolutionRateFormatted || "0.0%"}</div>
              <span className="metric-hint">Closed ÷ total issues</span>
            </div>

            <div
              className="metric-card mttr"
              onClick={() => setActiveTab("analytics")}
              role="button"
              tabIndex={0}
              title="View Mean Time to Resolution analytics"
            >
              <div className="metric-header">
                <span className="metric-label">Avg MTTR</span>
                <Clock size={20} className="metric-icon icon-clock" />
              </div>
              <div className="metric-value">{analytics?.mttr?.formatted || "Pending"}</div>
              <span className="metric-hint">
                {analytics?.mttr?.sampleSize
                  ? `${analytics.mttr.sampleSize} verified records`
                  : "Mean resolution time"}
              </span>
            </div>
          </section>
        )}

        {/* Navigation Tabs Bar */}
        <nav className="dashboard-tabs-bar" aria-label="Issue Filter Views">
          <button
            className={`tab-btn ${activeTab === "all" ? "active" : ""}`}
            onClick={() => setActiveTab("all")}
          >
            All Issues <span className="tab-badge">{totalCount}</span>
          </button>
          <button
            className={`tab-btn tab-needs-review ${activeTab === "needs_review" ? "active" : ""}`}
            data-testid="tab-needs-review"
            onClick={() => {
              setActiveTab("needs_review");
              setReviewFilter("needs_review");
            }}
          >
            <Layers size={15} /> Needs Review{" "}
            {needsReviewCount > 0 && <span className="tab-badge badge-alert">{needsReviewCount}</span>}
          </button>
          <button
            className={`tab-btn ${activeTab === "reported" ? "active" : ""}`}
            onClick={() => setActiveTab("reported")}
          >
            Reported <span className="tab-badge">{reportedCount}</span>
          </button>
          <button
            className={`tab-btn ${activeTab === "in-progress" ? "active" : ""}`}
            onClick={() => setActiveTab("in-progress")}
          >
            In Progress <span className="tab-badge">{inProgressCount}</span>
          </button>
          <button
            className={`tab-btn ${activeTab === "resolved" ? "active" : ""}`}
            onClick={() => setActiveTab("resolved")}
          >
            Resolved <span className="tab-badge">{resolvedCount}</span>
          </button>
          <button
            className={`tab-btn tab-hotspots ${activeTab === "hotspots" ? "active" : ""}`}
            data-testid="tab-hotspots"
            onClick={() => setActiveTab("hotspots")}
          >
            <Flame size={15} /> Hotspots (DBSCAN)
          </button>
          <button
            className={`tab-btn tab-notifications ${activeTab === "notifications" ? "active" : ""}`}
            data-testid="tab-notifications"
            onClick={() => setActiveTab("notifications")}
          >
            <Bell size={15} /> Notifications{" "}
            {unreadNotificationsCount > 0 && (
              <span className="tab-badge badge-unread-count" data-testid="tab-unread-badge">
                {unreadNotificationsCount}
              </span>
            )}
          </button>
          <button
            className={`tab-btn tab-analytics ${activeTab === "analytics" ? "active" : ""}`}
            data-testid="tab-analytics"
            onClick={() => setActiveTab("analytics")}
          >
            <BarChart3 size={15} /> Performance Analytics
          </button>
        </nav>

        {activeTab === "hotspots" ? (
          <HotspotsSection
            initialSelectedHotspotId={targetHotspotId}
            onClearInitialHotspotId={() => setTargetHotspotId(null)}
          />
        ) : activeTab === "notifications" ? (
          <NotificationCenter
            onNavigateToHotspot={handleNavigateToHotspot}
            onUnreadCountChange={setUnreadNotificationsCount}
          />
        ) : activeTab === "analytics" ? (
          <AnalyticsSection
            analytics={analytics}
            loading={analyticsLoading}
            error={analyticsError}
            selectedDays={analyticsDays}
            onDaysChange={(d) => {
              setAnalyticsDays(d);
              fetchAnalyticsData(d);
            }}
            onRefresh={() => fetchAnalyticsData(analyticsDays)}
          />
        ) : (

          <>
            {/* Filter and Search Controls */}
            <section className="toolbar-section">
              <div className="search-bar">
                <Search size={18} className="search-icon" />
                <input
                  type="text"
                  placeholder="Search by ID, keyword, parent ID, or citizen reporter..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  aria-label="Search issues"
                />
                {searchQuery && (
                  <button
                    className="clear-search-btn"
                    onClick={() => setSearchQuery("")}
                    aria-label="Clear search"
                  >
                    <X size={16} />
                  </button>
                )}
              </div>

              <div className="filters-row">
                <div className="filter-item">
                  <Filter size={16} className="filter-icon" />
                  <label htmlFor="status-filter">Status:</label>
                  <select
                    id="status-filter"
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                  >
                    <option value="all">All Statuses</option>
                    <option value="reported">Reported</option>
                    <option value="in-progress">In Progress</option>
                    <option value="resolved">Resolved</option>
                  </select>
                </div>

                <div className="filter-item">
                  <label htmlFor="type-filter">Category:</label>
                  <select
                    id="type-filter"
                    value={typeFilter}
                    onChange={(e) => setTypeFilter(e.target.value)}
                  >
                    {ISSUE_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t.charAt(0).toUpperCase() + t.slice(1)}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="filter-item">
                  <label htmlFor="dept-filter">Department:</label>
                  <select
                    id="dept-filter"
                    value={departmentFilter}
                    onChange={(e) => setDepartmentFilter(e.target.value)}
                  >
                    <option value="all">All Departments</option>
                    {DEPARTMENTS.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="filter-item">
                  <label htmlFor="review-filter">Duplicate Review:</label>
                  <select
                    id="review-filter"
                    value={reviewFilter}
                    onChange={(e) => setReviewFilter(e.target.value)}
                  >
                    {REVIEW_STATUS_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                {(statusFilter !== "all" ||
                  typeFilter !== "all" ||
                  departmentFilter !== "all" ||
                  reviewFilter !== "all" ||
                  activeTab !== "all" ||
                  searchQuery) && (
                  <button
                    className="btn-reset-filters"
                    onClick={() => {
                      setStatusFilter("all");
                      setTypeFilter("all");
                      setDepartmentFilter("all");
                      setReviewFilter("all");
                      setActiveTab("all");
                      setSearchQuery("");
                    }}
                  >
                    Reset All Filters
                  </button>
                )}
              </div>
            </section>

            {/* Issues Table Section */}
            <section className="issues-view-container">
              {loading ? (
                <div className="loading-state" data-testid="dashboard-loading">
                  <div className="spinner"></div>
                  <p>Loading community issues from secure admin endpoint...</p>
                </div>
              ) : error ? (
                <div className="error-state" data-testid="dashboard-error">
                  <AlertTriangle size={36} className="error-icon" />
                  <h3>Failed to Retrieve Issues</h3>
                  <p>{error}</p>
                  <button onClick={fetchIssues} className="btn-retry">
                    <RefreshCw size={16} /> Try Again
                  </button>
                </div>
              ) : filteredIssues.length === 0 ? (
                <div className="empty-state" data-testid="dashboard-empty">
                  <CheckCircle2 size={36} className="empty-icon" />
                  <h3>No Issues Found</h3>
                  <p>
                    {issues.length === 0
                      ? "There are currently no community issues reported in the system."
                      : activeTab === "needs_review"
                      ? "Great job! There are no duplicate issues currently pending manual review."
                      : "No issues match the selected search or filter criteria."}
                  </p>
                  {issues.length > 0 && (
                    <button
                      className="btn-retry"
                      onClick={() => {
                        setStatusFilter("all");
                        setTypeFilter("all");
                        setDepartmentFilter("all");
                        setReviewFilter("all");
                        setActiveTab("all");
                        setSearchQuery("");
                      }}
                    >
                      Clear Filters
                    </button>
                  )}
                </div>
              ) : (
                <div className="table-wrapper">
                  <table className="issues-table">
                    <thead>
                      <tr>
                        <th>Type & ID</th>
                        <th>Description</th>
                        <th>Citizen Reporter</th>
                        <th>Department</th>
                        <th>Severity</th>
                        <th>Status & Review</th>
                        <th>Votes</th>
                        <th>Reported Date</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredIssues.map((issue) => (
                        <tr key={issue._id} className="issue-row">
                          <td className="type-cell">
                            <div className="type-badge-group">
                              <span className="type-badge">{issue.type}</span>
                              <span className="issue-id">#{issue._id.slice(-6)}</span>
                            </div>

                            {/* Review State Badges */}
                            <div className="review-badges-stack">
                              {issue.needsDuplicateReview && (
                                <span className="badge-flagged-dup" title="Pending duplicate review">
                                  <Layers size={12} /> Dup Review
                                </span>
                              )}

                              {issue.needsClassificationReview && (
                                <span className="badge-triage-review" title="Pending category triage review">
                                  <AlertTriangle size={12} /> Triage Review
                                </span>
                              )}

                              {issue.needsReview && !issue.needsDuplicateReview && !issue.needsClassificationReview && (
                                <span className="badge-needs-review" title="Pending manual review">
                                  <AlertTriangle size={12} /> Needs Review
                                </span>
                              )}

                              {issue.duplicateStatus === "flagged_duplicate" && !issue.needsDuplicateReview && (
                                <span
                                  className="badge-flagged-dup"
                                  title={`AI flagged potential duplicate (${Math.round((issue.similarityScore || 0) * 100)}% match)`}
                                >
                                  <Layers size={12} /> AI Dup{" "}
                                  {issue.similarityScore ? `(${Math.round(issue.similarityScore * 100)}%)` : ""}
                                </span>
                              )}

                              {issue.duplicateStatus === "unverified" && !issue.needsDuplicateReview && (
                                <span className="badge-unverified-ai" title="AI check unverified">
                                  <HelpCircle size={12} /> Unverified AI
                                </span>
                              )}

                              {issue.reviewResolution === "confirmed_duplicate" && (
                                <span className="badge-confirmed-dup" title="Admin confirmed duplicate">
                                  <CheckCircle2 size={12} /> Confirmed Dup
                                </span>
                              )}

                              {issue.reviewResolution === "dismissed_unique" && (
                                <span className="badge-dismissed-unique" title="Admin marked distinct/unique">
                                  <ShieldCheck size={12} /> Distinct
                                </span>
                              )}
                            </div>
                          </td>

                          <td className="desc-cell">
                            <p className="desc-text" title={issue.description}>
                              {issue.description}
                            </p>
                            {issue.imageUrl && (
                              <span className="has-photo-tag">Photo attached</span>
                            )}
                            {issue.duplicateOf && (
                              <div className="dup-ref-tag">
                                <span className="dup-ref-label">Linked to:</span>
                                <span className="dup-ref-id">
                                  #{typeof issue.duplicateOf === "object" ? issue.duplicateOf._id.slice(-6) : issue.duplicateOf.slice(-6)}
                                </span>
                              </div>
                            )}
                          </td>

                          <td className="reporter-cell">
                            {issue.userId ? (
                              <div className="reporter-info">
                                <span className="reporter-name">
                                  {issue.userId.fullName || "Citizen"}
                                </span>
                                <span className="reporter-email">{issue.userId.email}</span>
                              </div>
                            ) : (
                              <span className="anonymous-tag">Anonymous / Deleted</span>
                            )}
                          </td>

                          <td className="dept-cell">
                            {issue.department ? (
                              <span className="dept-text">{issue.department}</span>
                            ) : (
                              <span className="unassigned-text">Unassigned</span>
                            )}
                          </td>

                          <td className="severity-cell" data-label="Severity">
                            {issue.severity !== null && issue.severity !== undefined ? (
                              <div
                                className="severity-metric-wrap"
                                title={getSeverityBadgeInfo(issue.severity).tooltip}
                              >
                                <span className={`severity-pill ${getSeverityBadgeInfo(issue.severity).pillClass}`}>
                                  <span className="severity-band-label">{getSeverityBadgeInfo(issue.severity).label}</span>
                                  <span className="severity-score-val">{getSeverityBadgeInfo(issue.severity).scoreFormatted}</span>
                                </span>
                                <span className="severity-heuristic-label">Heuristic</span>
                              </div>
                            ) : (
                              <div className="severity-metric-wrap" title="Severity estimate unavailable">
                                <span className="severity-pill severity-pill-unavailable">
                                  <span className="severity-score-val">—</span>
                                </span>
                                <span className="severity-heuristic-label text-muted">N/A</span>
                              </div>
                            )}
                          </td>

                          <td className="status-cell">
                            <span className={`status-pill ${issue.status || "reported"}`}>
                              {issue.status === "in-progress"
                                ? "In Progress"
                                : (issue.status || "reported").charAt(0).toUpperCase() +
                                  (issue.status || "reported").slice(1)}
                            </span>
                          </td>

                          <td className="votes-cell">
                            <span className="votes-count">
                              <ThumbsUp size={14} /> {issue.votes || 0}
                            </span>
                          </td>

                          <td className="date-cell">
                            {new Date(issue.createdAt).toLocaleDateString(undefined, {
                              month: "short",
                              day: "numeric",
                              year: "numeric"
                            })}
                          </td>

                          <td className="actions-cell">
                            <div className="actions-buttons">
                              {/* Dedicated Compare button if duplicate candidate or needs review */}
                              {(issue.needsReview ||
                                issue.duplicateStatus === "flagged_duplicate" ||
                                issue.duplicateOf) && (
                                <button
                                  className="btn-action-compare"
                                  onClick={() => handleOpenComparison(issue)}
                                  title="Open side-by-side duplicate comparison"
                                  aria-label={`Compare duplicate issue ${issue._id}`}
                                >
                                  <Layers size={14} />
                                  <span>Compare</span>
                                </button>
                              )}

                              <button
                                className="btn-action-review"
                                onClick={() => handleOpenDetail(issue)}
                                title="Inspect and update triage status"
                                aria-label={`Triage issue ${issue._id}`}
                              >
                                Triage
                              </button>

                              <button
                                className="btn-action-delete"
                                onClick={() => setIssueToDelete(issue)}
                                title="Delete issue"
                                aria-label={`Delete issue ${issue._id}`}
                              >
                                <Trash2 size={15} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </main>

      {/* Side-by-Side Duplicate Comparison & Resolution Modal */}
      {comparisonIssue && (
        <div className="modal-overlay" onClick={handleCloseComparison}>
          <div
            className="comparison-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-comparison-title"
          >
            {/* Modal Header */}
            <div className="comparison-header">
              <div className="comparison-header-title">
                <Layers size={22} className="header-icon-layer" />
                <div>
                  <h2 id="modal-comparison-title" className="comp-title-text">
                    Duplicate Assessment & Moderation
                  </h2>
                  <span className="comp-subtitle-text">
                    Candidate Issue #{comparisonIssue._id} &bull; Type: {comparisonIssue.type}
                  </span>
                </div>
              </div>
              <button
                className="btn-modal-close"
                onClick={handleCloseComparison}
                aria-label="Close comparison view"
              >
                <X size={20} />
              </button>
            </div>

            {/* Modal Body */}
            <div className="comparison-body">
              {/* Alert Message Banner if any */}
              {reviewMessage && (
                <div className={`alert-banner ${reviewMessage.type}`} role="alert">
                  {reviewMessage.text}
                </div>
              )}

              {/* Assessment Summary Banner */}
              <div
                className={`assessment-banner ${
                  comparisonIssue.reviewResolution === "confirmed_duplicate"
                    ? "status-confirmed"
                    : comparisonIssue.reviewResolution === "dismissed_unique"
                    ? "status-dismissed"
                    : comparisonIssue.duplicateStatus === "flagged_duplicate"
                    ? "status-flagged"
                    : "status-unverified"
                }`}
              >
                <div className="assessment-banner-left">
                  {comparisonIssue.reviewResolution === "confirmed_duplicate" ? (
                    <CheckCircle2 size={24} className="banner-icon-confirmed" />
                  ) : comparisonIssue.reviewResolution === "dismissed_unique" ? (
                    <ShieldCheck size={24} className="banner-icon-dismissed" />
                  ) : comparisonIssue.duplicateStatus === "flagged_duplicate" ? (
                    <Layers size={24} className="banner-icon-flagged" />
                  ) : (
                    <HelpCircle size={24} className="banner-icon-unverified" />
                  )}
                  <div>
                    <h4 className="banner-heading">
                      {comparisonIssue.reviewResolution === "confirmed_duplicate"
                        ? "Duplicate Confirmed by Administrator"
                        : comparisonIssue.reviewResolution === "dismissed_unique"
                        ? "Duplicate Flag Dismissed — Marked as Distinct"
                        : comparisonIssue.duplicateStatus === "flagged_duplicate"
                        ? "AI Suspected Duplicate Detected"
                        : "AI Assessment Unverified"}
                    </h4>
                    <p className="banner-subtext">
                      {comparisonIssue.reviewResolution !== "none"
                        ? `Resolved by ${
                            comparisonIssue.reviewedBy?.fullName || "Administrator"
                          } on ${new Date(comparisonIssue.reviewedAt).toLocaleString()}.`
                        : comparisonIssue.duplicateStatus === "flagged_duplicate"
                        ? `Stage 2 image feature similarity: ${(
                            (comparisonIssue.similarityScore || 0) * 100
                          ).toFixed(1)}%. Inspect both reports side by side before confirming.`
                        : "Nearby issue detected within 50m, but image features could not be compared automatically. Visual review required."}
                    </p>
                  </div>
                </div>

                <div className="assessment-banner-right">
                  {comparisonIssue.similarityScore !== undefined && (
                    <div className="metric-score-box">
                      <span className="score-label">Cosine Similarity</span>
                      <span className="score-val">
                        {(comparisonIssue.similarityScore * 100).toFixed(1)}%
                      </span>
                      <span className="score-engine-note">
                        * Deterministic engine (manual verification required)
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {/* Side-by-Side Comparison Grid */}
              <div className="comparison-grid">
                {/* Left Card: Reported Candidate Under Review */}
                <div className="comparison-card candidate-card">
                  <div className="card-top-tag tag-candidate">
                    <span>Report Under Review (Candidate)</span>
                    <span className="pill-id">#{comparisonIssue._id.slice(-6)}</span>
                  </div>

                  <div className="comparison-image-box">
                    {comparisonIssue.imageUrl ? (
                      <img
                        src={getImageUrl(comparisonIssue.imageUrl)}
                        alt={`Candidate report ${comparisonIssue.type}`}
                        className="comp-img"
                        onError={(e) => {
                          e.target.style.display = "none";
                        }}
                      />
                    ) : (
                      <div className="comp-img-placeholder">
                        <FileText size={32} />
                        <span>No Photo Provided</span>
                      </div>
                    )}
                  </div>

                  <div className="comp-details-list">
                    <div className="comp-detail-item">
                      <span className="detail-label">Issue Category & Status</span>
                      <div className="detail-val-inline">
                        <span className="type-badge">{comparisonIssue.type}</span>
                        <span className={`status-pill ${comparisonIssue.status || "reported"}`}>
                          {comparisonIssue.status}
                        </span>
                      </div>
                    </div>

                    <div className="comp-detail-item">
                      <span className="detail-label">Heuristic Severity</span>
                      <div className="detail-val-inline">
                        {comparisonIssue.severity !== null && comparisonIssue.severity !== undefined ? (
                          <div className="severity-metric-inline">
                            <span className={`severity-pill ${getSeverityBadgeInfo(comparisonIssue.severity).pillClass}`}>
                              <span className="severity-band-label">{getSeverityBadgeInfo(comparisonIssue.severity).label}</span>
                              <span className="severity-score-val">{getSeverityBadgeInfo(comparisonIssue.severity).scoreFormatted}</span>
                            </span>
                            <span className="severity-heuristic-sublabel">Rule-based heuristic</span>
                          </div>
                        ) : (
                          <span className="text-muted">— Unavailable</span>
                        )}
                      </div>
                    </div>

                    <div className="comp-detail-item">
                      <span className="detail-label">Citizen Description</span>
                      <p className="comp-desc-text">{comparisonIssue.description}</p>
                    </div>

                    <div className="comp-detail-item">
                      <span className="detail-label">Geographic Location</span>
                      <div className="location-box">
                        <MapPin size={16} />
                        <span>
                          Lat: {comparisonIssue.location?.lat?.toFixed(5)}, Lng:{" "}
                          {comparisonIssue.location?.lng?.toFixed(5)}
                        </span>
                        {comparisonIssue.location && (
                          <a
                            href={`https://www.openstreetmap.org/?mlat=${comparisonIssue.location.lat}&mlon=${comparisonIssue.location.lng}#map=17/${comparisonIssue.location.lat}/${comparisonIssue.location.lng}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="link-external-map"
                          >
                            <ExternalLink size={14} /> Open Map
                          </a>
                        )}
                      </div>
                    </div>

                    <div className="comp-detail-item">
                      <span className="detail-label">Citizen Reporter</span>
                      <div className="reporter-field">
                        <User size={15} />
                        <span>
                          {comparisonIssue.userId?.fullName || "Citizen"} (
                          {comparisonIssue.userId?.email || "Email hidden"}
                          )
                        </span>
                      </div>
                    </div>

                    <div className="comp-detail-item">
                      <span className="detail-label">Reported Timestamp</span>
                      <span className="detail-val-text">
                        <Calendar size={14} /> {new Date(comparisonIssue.createdAt).toLocaleString()}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Center Bridge (Desktop only) */}
                <div className="comparison-bridge">
                  <div className="bridge-pill">
                    <span className="bridge-vs">VS</span>
                    {comparisonIssue.duplicateOf &&
                      typeof comparisonIssue.duplicateOf === "object" && (
                        <span className="bridge-distance">
                          {calculateDistanceMeters(
                            comparisonIssue.location,
                            comparisonIssue.duplicateOf.location
                          ) !== null
                            ? `${calculateDistanceMeters(
                                comparisonIssue.location,
                                comparisonIssue.duplicateOf.location
                              )}m apart`
                            : "Proximity match"}
                        </span>
                      )}
                  </div>
                </div>

                {/* Right Card: Suspected Original Parent Issue */}
                <div className="comparison-card parent-card">
                  <div className="card-top-tag tag-parent">
                    <span>Suspected Original Report (Parent Issue)</span>
                    <span className="pill-id">
                      #
                      {typeof comparisonIssue.duplicateOf === "object" && comparisonIssue.duplicateOf
                        ? comparisonIssue.duplicateOf._id.slice(-6)
                        : typeof comparisonIssue.duplicateOf === "string"
                        ? comparisonIssue.duplicateOf.slice(-6)
                        : "None"}
                    </span>
                  </div>

                  {comparisonIssue.duplicateOf &&
                  typeof comparisonIssue.duplicateOf === "object" ? (
                    <>
                      <div className="comparison-image-box">
                        {comparisonIssue.duplicateOf.imageUrl ? (
                          <img
                            src={getImageUrl(comparisonIssue.duplicateOf.imageUrl)}
                            alt={`Parent report ${comparisonIssue.duplicateOf.type}`}
                            className="comp-img"
                            onError={(e) => {
                              e.target.style.display = "none";
                            }}
                          />
                        ) : (
                          <div className="comp-img-placeholder">
                            <FileText size={32} />
                            <span>No Photo in Parent Issue</span>
                          </div>
                        )}
                      </div>

                      <div className="comp-details-list">
                        <div className="comp-detail-item">
                          <span className="detail-label">Issue Category & Status</span>
                          <div className="detail-val-inline">
                            <span className="type-badge">{comparisonIssue.duplicateOf.type}</span>
                            <span
                              className={`status-pill ${
                                comparisonIssue.duplicateOf.status || "reported"
                              }`}
                            >
                              {comparisonIssue.duplicateOf.status}
                            </span>
                          </div>
                        </div>

                        <div className="comp-detail-item">
                          <span className="detail-label">Heuristic Severity</span>
                          <div className="detail-val-inline">
                            {comparisonIssue.duplicateOf.severity !== null &&
                            comparisonIssue.duplicateOf.severity !== undefined ? (
                              <div className="severity-metric-inline">
                                <span
                                  className={`severity-pill ${
                                    getSeverityBadgeInfo(comparisonIssue.duplicateOf.severity).pillClass
                                  }`}
                                >
                                  <span className="severity-band-label">
                                    {getSeverityBadgeInfo(comparisonIssue.duplicateOf.severity).label}
                                  </span>
                                  <span className="severity-score-val">
                                    {
                                      getSeverityBadgeInfo(comparisonIssue.duplicateOf.severity)
                                        .scoreFormatted
                                    }
                                  </span>
                                </span>
                                <span className="severity-heuristic-sublabel">
                                  Rule-based heuristic
                                </span>
                              </div>
                            ) : (
                              <span className="text-muted">— Unavailable</span>
                            )}
                          </div>
                        </div>

                        <div className="comp-detail-item">
                          <span className="detail-label">Citizen Description</span>
                          <p className="comp-desc-text">
                            {comparisonIssue.duplicateOf.description}
                          </p>
                        </div>

                        <div className="comp-detail-item">
                          <span className="detail-label">Geographic Location</span>
                          <div className="location-box">
                            <MapPin size={16} />
                            <span>
                              Lat: {comparisonIssue.duplicateOf.location?.lat?.toFixed(5)}, Lng:{" "}
                              {comparisonIssue.duplicateOf.location?.lng?.toFixed(5)}
                            </span>
                            {comparisonIssue.duplicateOf.location && (
                              <a
                                href={`https://www.openstreetmap.org/?mlat=${comparisonIssue.duplicateOf.location.lat}&mlon=${comparisonIssue.duplicateOf.location.lng}#map=17/${comparisonIssue.duplicateOf.location.lat}/${comparisonIssue.duplicateOf.location.lng}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="link-external-map"
                              >
                                <ExternalLink size={14} /> Open Map
                              </a>
                            )}
                          </div>
                        </div>

                        <div className="comp-detail-item">
                          <span className="detail-label">Original Reported Timestamp</span>
                          <span className="detail-val-text">
                            <Calendar size={14} />{" "}
                            {new Date(comparisonIssue.duplicateOf.createdAt).toLocaleString()}
                          </span>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="missing-parent-box">
                      <HelpCircle size={40} className="missing-icon" />
                      <h4>Parent Issue Details Unavailable</h4>
                      <p>
                        {typeof comparisonIssue.duplicateOf === "string"
                          ? `Referenced parent ID #${comparisonIssue.duplicateOf} was not found or was deleted from the database.`
                          : "This issue was flagged unverified due to geographic proximity with nearby defects, but was not tied to a single parent record."}
                      </p>
                    </div>
                  )}
                </div>
              </div>

              {/* Review Decision & Resolution Panel */}
              <div className="review-decision-panel">
                <h3 className="decision-title">
                  <ShieldCheck size={18} /> Administrative Duplicate Resolution
                </h3>

                {/* In-modal confirmation prompt if clicked */}
                {confirmDialog ? (
                  <div className="confirm-resolution-box" role="alertdialog">
                    <div className="confirm-text-group">
                      <AlertTriangle size={24} className="confirm-icon-warn" />
                      <div>
                        <h4 className="confirm-box-title">
                          {confirmDialog.action === "confirm_duplicate"
                            ? "Confirm Issue as Duplicate?"
                            : "Dismiss Duplicate Flag & Mark as Unique?"}
                        </h4>
                        <p className="confirm-box-p">
                          {confirmDialog.action === "confirm_duplicate"
                            ? "This will record that this report refers to the existing defect and marks the duplicate review as resolved. The report will NOT be deleted or merged."
                            : "This will dismiss the AI duplicate flag and mark this report as an independent distinct civic issue. The issue will remain active."}
                        </p>
                      </div>
                    </div>

                    <div className="confirm-buttons-row">
                      <button
                        className="btn-cancel-dialog"
                        onClick={handleCancelConfirm}
                        disabled={submittingReview}
                      >
                        Cancel
                      </button>
                      <button
                        className={
                          confirmDialog.action === "confirm_duplicate"
                            ? "btn-execute-confirm"
                            : "btn-execute-dismiss"
                        }
                        onClick={handleExecuteReviewAction}
                        disabled={submittingReview}
                      >
                        {submittingReview
                          ? "Submitting Decision..."
                          : confirmDialog.action === "confirm_duplicate"
                          ? "Yes, Confirm Duplicate"
                          : "Yes, Mark as Unique"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="decision-form-body">
                    <div className="form-group">
                      <label htmlFor="review-notes-input">
                        Administrator Resolution Justification / Notes (Optional)
                      </label>
                      <textarea
                        id="review-notes-input"
                        rows={2}
                        placeholder="Log reason for confirmation or dismissal (e.g., identical angle/defect, distinct street corner, different time)..."
                        value={reviewNotes}
                        onChange={(e) => setReviewNotes(e.target.value)}
                        disabled={submittingReview}
                      />
                    </div>

                    <div className="decision-action-buttons">
                      <button
                        type="button"
                        className="btn-confirm-duplicate"
                        onClick={() => handleRequestReviewAction("confirm_duplicate")}
                        disabled={submittingReview}
                      >
                        <CheckCircle2 size={16} />
                        <span>Confirm Duplicate</span>
                      </button>

                      <button
                        type="button"
                        className="btn-dismiss-duplicate"
                        onClick={() => handleRequestReviewAction("dismiss_duplicate")}
                        disabled={submittingReview}
                      >
                        <ShieldCheck size={16} />
                        <span>Dismiss Duplicate / Mark Unique</span>
                      </button>
                    </div>

                    {comparisonIssue.reviewResolution !== "none" && (
                      <p className="review-history-note">
                        Current resolution:{" "}
                        <strong>{comparisonIssue.reviewResolution.replace("_", " ")}</strong>. You
                        may re-submit above to update this decision.
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Issue Detail & Triage Modal */}
      {selectedIssue && (
        <div className="modal-overlay" onClick={handleCloseDetail}>
          <div
            className="detail-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-issue-title"
          >
            <div className="modal-header">
              <div className="modal-header-left">
                <span className="modal-type-tag">{selectedIssue.type}</span>
                <h2 id="modal-issue-title" className="modal-title">
                  Issue #{selectedIssue._id}
                </h2>
              </div>
              <button
                className="btn-modal-close"
                onClick={handleCloseDetail}
                aria-label="Close modal"
              >
                <X size={20} />
              </button>
            </div>

            <div className="modal-body">
              {updateMessage && (
                <div className={`alert-banner ${updateMessage.type}`} role="alert">
                  {updateMessage.text}
                </div>
              )}

              {/* Duplicate alert card in detail modal */}
              {(selectedIssue.needsReview ||
                selectedIssue.duplicateStatus === "flagged_duplicate" ||
                selectedIssue.duplicateOf) && (
                <div className="duplicate-alert-banner">
                  <div className="dup-alert-left">
                    <Layers size={20} className="dup-alert-icon" />
                    <div>
                      <span className="dup-alert-title">
                        AI Duplicate Assessment:{" "}
                        {selectedIssue.duplicateStatus === "flagged_duplicate"
                          ? "Suspected Duplicate"
                          : selectedIssue.duplicateStatus === "unverified"
                          ? "Unverified Candidate"
                          : "Duplicate Check Logged"}
                      </span>
                      <p className="dup-alert-p">
                        {selectedIssue.duplicateStatus === "flagged_duplicate"
                          ? `Similarity: ${Math.round((selectedIssue.similarityScore || 0) * 100)}%. Requires visual confirmation.`
                          : "Nearby defects detected. Inspect side by side with suspected parent report."}
                      </p>
                    </div>
                  </div>
                  <button
                    className="btn-open-comp-from-detail"
                    onClick={() => {
                      handleOpenComparison(selectedIssue);
                    }}
                  >
                    <Layers size={15} /> Side-by-Side Review
                  </button>
                </div>
              )}

              <div className="modal-grid">
                {/* Left side: Issue Info and Media */}
                <div className="modal-left-col">
                  {selectedIssue.imageUrl && (
                    <div className="issue-image-container">
                      <img
                        src={getImageUrl(selectedIssue.imageUrl)}
                        alt={`Attachment for issue ${selectedIssue.type}`}
                        className="issue-image"
                        onError={(e) => {
                          e.target.style.display = "none";
                        }}
                      />
                    </div>
                  )}

                  <div className="info-block">
                    <label>Citizen Description</label>
                    <p className="info-value-desc">{selectedIssue.description}</p>
                  </div>

                  <div className="info-block">
                    <label>Citizen Reporter Information</label>
                    {selectedIssue.userId ? (
                      <div className="reporter-card">
                        <div className="reporter-field">
                          <User size={16} />
                          <span>{selectedIssue.userId.fullName || "Citizen"}</span>
                        </div>
                        <div className="reporter-field">
                          <Mail size={16} />
                          <span>{selectedIssue.userId.email}</span>
                        </div>
                      </div>
                    ) : (
                      <p className="text-muted">No citizen profile attached</p>
                    )}
                  </div>

                  {selectedIssue.location && (
                    <div className="info-block">
                      <label>Geographic Location</label>
                      <div className="location-box">
                        <MapPin size={16} />
                        <span>
                          Lat: {selectedIssue.location.lat?.toFixed(5)}, Lng:{" "}
                          {selectedIssue.location.lng?.toFixed(5)}
                        </span>
                        <a
                          href={`https://www.openstreetmap.org/?mlat=${selectedIssue.location.lat}&mlon=${selectedIssue.location.lng}#map=16/${selectedIssue.location.lat}/${selectedIssue.location.lng}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="link-external-map"
                        >
                          <ExternalLink size={14} /> View Map
                        </a>
                      </div>
                    </div>
                  )}

                  <div className="info-block">
                    <label>Issue Metadata</label>
                    <div className="meta-row">
                      <span>
                        <Calendar size={14} /> Reported:{" "}
                        {new Date(selectedIssue.createdAt).toLocaleString()}
                      </span>
                      <span>
                        <ThumbsUp size={14} /> Community Votes: {selectedIssue.votes || 0}
                      </span>
                    </div>
                  </div>

                  <div className="info-block">
                    <label>Severity Assessment</label>
                    {selectedIssue.severity !== null && selectedIssue.severity !== undefined ? (
                      <div className="detail-severity-box">
                        <div className="severity-metric-inline">
                          <span className={`severity-pill ${getSeverityBadgeInfo(selectedIssue.severity).pillClass}`}>
                            <span className="severity-band-label">{getSeverityBadgeInfo(selectedIssue.severity).label}</span>
                            <span className="severity-score-val">{getSeverityBadgeInfo(selectedIssue.severity).scoreFormatted}</span>
                          </span>
                          <span className="severity-heuristic-sublabel">Rule-based heuristic</span>
                        </div>
                        <p className="severity-explanatory-text">
                          Score calculated via defect category base weight and image edge density heuristic (1.0–10.0 scale). This is a deterministic rule-based estimate, not a trained neural model prediction.
                        </p>
                      </div>
                    ) : (
                      <div className="detail-severity-box">
                        <span className="severity-pill severity-pill-unavailable">
                          <span className="severity-score-val">—</span>
                        </span>
                        <span className="text-muted" style={{ marginLeft: 8, fontSize: "0.85rem" }}>
                          Severity estimate unavailable (unprocessed or photo missing)
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Right side: Management & Triage Form */}
                <div className="modal-right-col">
                  <h3 className="section-title">
                    <Building2 size={18} /> Administrative Action & Triage
                  </h3>

                  <form onSubmit={handleUpdateSubmit} className="triage-form">
                    <div className="form-group">
                      <label htmlFor="update-status">Remediation Status</label>
                      <select
                        id="update-status"
                        value={updateForm.status}
                        onChange={(e) =>
                          setUpdateForm({ ...updateForm, status: e.target.value })
                        }
                      >
                        <option value="reported">Reported (Pending Triage)</option>
                        <option value="in-progress">In Progress (Work Assigned)</option>
                        <option value="resolved">Resolved (Completed)</option>
                      </select>
                    </div>

                    <div className="form-group">
                      <label htmlFor="update-department">Assigned Department</label>
                      <select
                        id="update-department"
                        value={updateForm.department}
                        onChange={(e) =>
                          setUpdateForm({ ...updateForm, department: e.target.value })
                        }
                      >
                        <option value="">-- Select Department --</option>
                        {DEPARTMENTS.map((dept) => (
                          <option key={dept} value={dept}>
                            {dept}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="form-group">
                      <label htmlFor="update-notes">
                        Internal Remediation Notes (Confidential)
                      </label>
                      <textarea
                        id="update-notes"
                        rows={4}
                        placeholder="Log work orders, contractor details, or internal notes..."
                        value={updateForm.internalNotes}
                        onChange={(e) =>
                          setUpdateForm({ ...updateForm, internalNotes: e.target.value })
                        }
                      />
                    </div>

                    <div className="modal-form-actions">
                      <button
                        type="submit"
                        className="btn-save-triage"
                        disabled={updating}
                      >
                        <Save size={16} />
                        {updating ? "Saving Changes..." : "Save Status & Assignment"}
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {issueToDelete && (
        <div className="modal-overlay" onClick={() => setIssueToDelete(null)}>
          <div
            className="confirm-modal"
            onClick={(e) => e.stopPropagation()}
            role="alertdialog"
            aria-labelledby="confirm-delete-title"
          >
            <div className="confirm-icon-wrapper">
              <Trash2 size={28} className="danger-icon" />
            </div>
            <h3 id="confirm-delete-title">Delete Issue Record?</h3>
            <p>
              Are you sure you want to permanently delete issue{" "}
              <strong>#{issueToDelete._id}</strong> ({issueToDelete.type})? This action
              cannot be undone.
            </p>
            <div className="confirm-actions">
              <button
                className="btn-cancel"
                onClick={() => setIssueToDelete(null)}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                className="btn-confirm-delete"
                onClick={handleConfirmDelete}
                disabled={deleting}
              >
                {deleting ? "Deleting..." : "Permanently Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Dashboard;
