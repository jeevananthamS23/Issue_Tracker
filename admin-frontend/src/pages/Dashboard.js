import React, { useState, useEffect, useCallback } from "react";
import { useAdminAuth } from "../context/AdminAuthContext";
import API, { getImageUrl } from "../api/api";
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
  FileText
} from "lucide-react";
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

const Dashboard = () => {
  const { admin, logout } = useAdminAuth();

  const [issues, setIssues] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  // Filters state
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [departmentFilter, setDepartmentFilter] = useState("all");

  // Selected issue for detail drawer / modal
  const [selectedIssue, setSelectedIssue] = useState(null);
  const [updating, setUpdating] = useState(false);
  const [updateMessage, setUpdateMessage] = useState(null);
  const [updateForm, setUpdateForm] = useState({
    status: "reported",
    department: "",
    internalNotes: ""
  });

  // Delete confirmation modal
  const [issueToDelete, setIssueToDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);

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

  useEffect(() => {
    fetchIssues();
  }, [fetchIssues]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchIssues();
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
      // Retain populated userId if backend doesn't re-populate on patch
      const merged = {
        ...selectedIssue,
        ...updated,
        userId: selectedIssue.userId
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
      setIssueToDelete(null);
    } catch (err) {
      alert(err.response?.data?.message || "Failed to delete issue.");
    } finally {
      setDeleting(false);
    }
  };

  // Filter issues
  const filteredIssues = issues.filter((issue) => {
    if (statusFilter !== "all" && issue.status !== statusFilter) return false;
    if (typeFilter !== "all" && issue.type?.toLowerCase() !== typeFilter.toLowerCase()) return false;
    if (departmentFilter !== "all" && issue.department !== departmentFilter) return false;

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const descMatch = issue.description?.toLowerCase().includes(q);
      const typeMatch = issue.type?.toLowerCase().includes(q);
      const idMatch = issue._id?.toLowerCase().includes(q);
      const reporterMatch =
        issue.userId?.fullName?.toLowerCase().includes(q) ||
        issue.userId?.email?.toLowerCase().includes(q);
      return descMatch || typeMatch || idMatch || reporterMatch;
    }

    return true;
  });

  // Calculate stats
  const totalCount = issues.length;
  const reportedCount = issues.filter((i) => i.status === "reported").length;
  const inProgressCount = issues.filter((i) => i.status === "in-progress").length;
  const resolvedCount = issues.filter((i) => i.status === "resolved").length;

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
        {/* Metric Cards */}
        <section className="metrics-grid">
          <div className="metric-card total">
            <div className="metric-header">
              <span className="metric-label">Total Issues</span>
              <FileText size={20} className="metric-icon" />
            </div>
            <div className="metric-value">{totalCount}</div>
            <span className="metric-hint">All reported civic issues</span>
          </div>

          <div className="metric-card reported">
            <div className="metric-header">
              <span className="metric-label">Reported</span>
              <AlertTriangle size={20} className="metric-icon" />
            </div>
            <div className="metric-value">{reportedCount}</div>
            <span className="metric-hint">Awaiting review & triage</span>
          </div>

          <div className="metric-card in-progress">
            <div className="metric-header">
              <span className="metric-label">In Progress</span>
              <Clock size={20} className="metric-icon" />
            </div>
            <div className="metric-value">{inProgressCount}</div>
            <span className="metric-hint">Under active municipal remediation</span>
          </div>

          <div className="metric-card resolved">
            <div className="metric-header">
              <span className="metric-label">Resolved</span>
              <CheckCircle2 size={20} className="metric-icon" />
            </div>
            <div className="metric-value">{resolvedCount}</div>
            <span className="metric-hint">Successfully completed</span>
          </div>
        </section>

        {/* Filter and Search Controls */}
        <section className="toolbar-section">
          <div className="search-bar">
            <Search size={18} className="search-icon" />
            <input
              type="text"
              placeholder="Search by ID, keyword, or citizen reporter..."
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

            {(statusFilter !== "all" || typeFilter !== "all" || departmentFilter !== "all" || searchQuery) && (
              <button
                className="btn-reset-filters"
                onClick={() => {
                  setStatusFilter("all");
                  setTypeFilter("all");
                  setDepartmentFilter("all");
                  setSearchQuery("");
                }}
              >
                Reset Filters
              </button>
            )}
          </div>
        </section>

        {/* Content Area: Loading / Error / Empty / Table */}
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
                  : "No issues match the selected search or filter criteria."}
              </p>
              {issues.length > 0 && (
                <button
                  className="btn-retry"
                  onClick={() => {
                    setStatusFilter("all");
                    setTypeFilter("all");
                    setDepartmentFilter("all");
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
                    <th>Status</th>
                    <th>Votes</th>
                    <th>Reported Date</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredIssues.map((issue) => (
                    <tr key={issue._id} className="issue-row">
                      <td className="type-cell">
                        <span className="type-badge">{issue.type}</span>
                        <span className="issue-id">#{issue._id.slice(-6)}</span>
                      </td>

                      <td className="desc-cell">
                        <p className="desc-text" title={issue.description}>
                          {issue.description}
                        </p>
                        {issue.imageUrl && (
                          <span className="has-photo-tag">Photo attached</span>
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
                          <button
                            className="btn-action-review"
                            onClick={() => handleOpenDetail(issue)}
                            title="Inspect and update issue"
                          >
                            Review
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
      </main>

      {/* Issue Detail and Management Modal */}
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
