import React, { useState, useEffect, useCallback } from "react";
import {
  Bell,
  CheckCheck,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  Clock,
  Flame,
  TrendingUp,
  RefreshCw,
  Filter,
  ChevronLeft,
  ChevronRight,
  Mail,
  ExternalLink,
  X
} from "lucide-react";
import {
  fetchNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  retryNotificationEmail
} from "../api/api";
import "./NotificationCenter.css";

/**
 * Resolves severity score out of 10 into Low, Medium, and High bands.
 * Matches existing admin severity visualization system.
 */
function getSeverityBadgeInfo(severity) {
  if (severity === null || severity === undefined || typeof severity !== "number" || isNaN(severity)) {
    return null;
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

function formatDate(dateStr) {
  if (!dateStr) return "—";
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return String(dateStr);
  }
}

const NotificationCenter = ({ onNavigateToHotspot, onUnreadCountChange }) => {
  const [notifications, setNotifications] = useState([]);
  const [totalNotifications, setTotalNotifications] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);

  // Filters state
  const [readFilter, setReadFilter] = useState("all"); // "all" | "false" | "true"
  const [typeFilter, setTypeFilter] = useState("all"); // "all" | "hotspot_detected" | "hotspot_escalated"

  // Loading & error state
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  // Per-action progress states to prevent double clicks
  const [actionInProgress, setActionInProgress] = useState({});
  const [markingAllRead, setMarkingAllRead] = useState(false);

  // User feedback message banner
  const [feedback, setFeedback] = useState(null); // { type: "success" | "error" | "warning", message: string }

  // Load notifications from server
  const loadNotifications = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const params = {
        page,
        limit
      };

      if (readFilter !== "all") {
        params.read = readFilter;
      }
      if (typeFilter !== "all") {
        params.type = typeFilter;
      }

      const res = await fetchNotifications(params);
      const data = res.data;

      setNotifications(Array.isArray(data.notifications) ? data.notifications : []);
      setTotalNotifications(typeof data.total === "number" ? data.total : (data.notifications?.length || 0));
      const unread = typeof data.unreadCount === "number" ? data.unreadCount : 0;
      setUnreadCount(unread);
      setTotalPages(data.totalPages || 1);

      if (onUnreadCountChange) {
        onUnreadCountChange(unread);
      }
    } catch (err) {
      console.error("Error loading notifications:", err);
      setError(
        err.response?.data?.message ||
        "Failed to load notifications from server. Please verify backend service and authentication."
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [page, limit, readFilter, typeFilter, onUnreadCountChange]);

  useEffect(() => {
    loadNotifications();
  }, [loadNotifications]);

  const handleManualRefresh = () => {
    setRefreshing(true);
    setFeedback(null);
    loadNotifications();
  };

  // Mark a single notification as read
  const handleMarkAsRead = async (id) => {
    if (actionInProgress[id]) return;

    setActionInProgress((prev) => ({ ...prev, [id]: true }));
    setFeedback(null);

    try {
      const res = await markNotificationRead(id);
      const updated = res.data.notification;

      setNotifications((prev) =>
        prev.map((item) => (item._id === id ? { ...item, readAt: updated?.readAt || new Date().toISOString() } : item))
      );

      setUnreadCount((prev) => Math.max(0, prev - 1));
      if (onUnreadCountChange) {
        onUnreadCountChange((prev) => Math.max(0, prev - 1));
      }


      setFeedback({
        type: "success",
        message: "Notification marked as read."
      });
    } catch (err) {
      console.error("Error marking notification read:", err);
      setFeedback({
        type: "error",
        message: err.response?.data?.message || "Failed to mark notification as read. Please try again."
      });
    } finally {
      setActionInProgress((prev) => ({ ...prev, [id]: false }));
    }
  };

  // Mark all notifications as read
  const handleMarkAllAsRead = async () => {
    if (markingAllRead || unreadCount === 0) return;

    setMarkingAllRead(true);
    setFeedback(null);

    try {
      const res = await markAllNotificationsRead();
      const now = new Date().toISOString();

      setNotifications((prev) =>
        prev.map((item) => ({ ...item, readAt: item.readAt || now }))
      );

      setUnreadCount(0);
      if (onUnreadCountChange) {
        onUnreadCountChange(0);
      }

      setFeedback({
        type: "success",
        message: res.data?.message || `All ${res.data?.markedCount ?? ""} notifications marked as read.`
      });
    } catch (err) {
      console.error("Error marking all read:", err);
      setFeedback({
        type: "error",
        message: err.response?.data?.message || "Failed to mark all notifications as read. Please try again."
      });
    } finally {
      setMarkingAllRead(false);
    }
  };

  // Retry sending email for a failed notification
  const handleRetryEmail = async (id, attemptCount) => {
    if (actionInProgress[id] || attemptCount >= 5) return;

    setActionInProgress((prev) => ({ ...prev, [id]: true }));
    setFeedback(null);

    try {
      const res = await retryNotificationEmail(id);
      const updated = res.data?.notification;

      if (updated) {
        setNotifications((prev) =>
          prev.map((item) => (item._id === id ? { ...item, ...updated } : item))
        );
      }

      setFeedback({
        type: "success",
        message: res.data?.message || "Email retry dispatched successfully."
      });
    } catch (err) {
      console.error("Error retrying notification email:", err);
      const returnedNotification = err.response?.data?.notification;
      if (returnedNotification) {
        setNotifications((prev) =>
          prev.map((item) => (item._id === id ? { ...item, ...returnedNotification } : item))
        );
      }

      setFeedback({
        type: "error",
        message: err.response?.data?.message || "Failed to retry email delivery. Check server mail logs."
      });
    } finally {
      setActionInProgress((prev) => ({ ...prev, [id]: false }));
    }
  };

  return (
    <div className="notification-center" data-testid="notification-center">
      {/* Header Section */}
      <div className="nc-header">
        <div className="nc-header-left">
          <div className="nc-title-row">
            <Bell size={24} className="nc-bell-icon" />
            <h2 className="nc-title">Admin Notification Center</h2>
            {unreadCount > 0 && (
              <span className="nc-unread-pill" data-testid="nc-unread-count-badge">
                {unreadCount} Unread
              </span>
            )}
          </div>
          <p className="nc-subtitle">
            Automated notifications for DBSCAN hotspot detections, escalation alerts, and email delivery dispatch.
          </p>
        </div>

        <div className="nc-header-right">
          <button
            type="button"
            className="btn-mark-all-read"
            onClick={handleMarkAllAsRead}
            disabled={markingAllRead || unreadCount === 0}
            data-testid="mark-all-read-btn"
            title={unreadCount === 0 ? "No unread notifications" : "Mark all notifications as read"}
          >
            <CheckCheck size={16} />
            <span>{markingAllRead ? "Marking..." : "Mark All as Read"}</span>
          </button>

          <button
            type="button"
            className={`btn-icon ${refreshing ? "spinning" : ""}`}
            onClick={handleManualRefresh}
            title="Refresh notifications"
            aria-label="Refresh notifications"
            data-testid="nc-refresh-btn"
          >
            <RefreshCw size={17} />
          </button>
        </div>
      </div>

      {/* Feedback Banner */}
      {feedback && (
        <div className={`nc-feedback-banner ${feedback.type}`} role="alert" data-testid="nc-feedback-alert">
          <div className="feedback-content">
            {feedback.type === "success" && <CheckCircle2 size={18} className="alert-icon" />}
            {feedback.type === "error" && <AlertCircle size={18} className="alert-icon" />}
            {feedback.type === "warning" && <AlertTriangle size={18} className="alert-icon" />}
            <span>{feedback.message}</span>
          </div>
          <button
            type="button"
            className="feedback-close-btn"
            onClick={() => setFeedback(null)}
            aria-label="Close notification message"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* Filter and Control Toolbar */}
      <div className="nc-toolbar">
        <div className="nc-filter-group">
          <Filter size={15} className="nc-filter-icon" />
          <label htmlFor="nc-read-filter">Read State:</label>
          <select
            id="nc-read-filter"
            data-testid="nc-read-filter"
            value={readFilter}
            onChange={(e) => {
              setReadFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="all">All Notifications</option>
            <option value="false">Unread Only</option>
            <option value="true">Read Only</option>
          </select>
        </div>

        <div className="nc-filter-group">
          <label htmlFor="nc-type-filter">Alert Type:</label>
          <select
            id="nc-type-filter"
            data-testid="nc-type-filter"
            value={typeFilter}
            onChange={(e) => {
              setTypeFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="all">All Alert Types</option>
            <option value="hotspot_detected">Hotspot Detected</option>
            <option value="hotspot_escalated">Hotspot Escalated</option>
          </select>
        </div>

        {(readFilter !== "all" || typeFilter !== "all") && (
          <button
            type="button"
            className="btn-reset-filters"
            onClick={() => {
              setReadFilter("all");
              setTypeFilter("all");
              setPage(1);
            }}
            data-testid="nc-reset-filters-btn"
          >
            Reset Filters
          </button>
        )}
      </div>

      {/* Main Notification List Container */}
      <div className="nc-list-container">
        {loading ? (
          <div className="loading-state" data-testid="nc-loading-state">
            <div className="spinner" />
            <p>Loading administrative notifications...</p>
          </div>
        ) : error ? (
          <div className="error-state" data-testid="nc-error-state">
            <AlertCircle size={36} className="error-icon" />
            <h3>Failed to Retrieve Notifications</h3>
            <p>{error}</p>
            <button type="button" className="btn-retry" onClick={loadNotifications}>
              <RefreshCw size={14} /> Try Again
            </button>
          </div>
        ) : notifications.length === 0 ? (
          <div className="empty-state" data-testid="nc-empty-state">
            <CheckCircle2 size={40} className="empty-icon" />
            <h3>No Notifications Found</h3>
            <p>
              {totalNotifications === 0
                ? "No administrative notifications have been generated yet. Notifications are automatically triggered when DBSCAN detects high-density defect clusters or escalating reports."
                : "No notifications match the active filter criteria."}
            </p>
            {(readFilter !== "all" || typeFilter !== "all") && (
              <button
                type="button"
                className="btn-retry"
                onClick={() => {
                  setReadFilter("all");
                  setTypeFilter("all");
                  setPage(1);
                }}
              >
                Clear Filters
              </button>
            )}
          </div>
        ) : (
          <div className="nc-cards-stack" data-testid="nc-cards-stack">
            {notifications.map((n) => {
              const isUnread = !n.readAt;
              const isDetected = n.type === "hotspot_detected";
              const isEscalated = n.type === "hotspot_escalated";
              const inAction = !!actionInProgress[n._id];
              const severityInfo = getSeverityBadgeInfo(n.severity);
              const maxRetriesReached = (n.emailAttemptCount || 0) >= 5;

              return (
                <div
                  key={n._id}
                  className={`nc-card ${isUnread ? "unread" : "read"} ${
                    isDetected ? "type-detected" : isEscalated ? "type-escalated" : ""
                  }`}
                  data-testid={`notification-card-${n._id}`}
                >
                  <div className="nc-card-header">
                    <div className="nc-card-tags">
                      {isDetected && (
                        <span className="nc-tag tag-detected" data-testid={`type-badge-${n._id}`}>
                          <Flame size={13} /> Hotspot Detected
                        </span>
                      )}
                      {isEscalated && (
                        <span className="nc-tag tag-escalated" data-testid={`type-badge-${n._id}`}>
                          <TrendingUp size={13} /> Hotspot Escalated
                        </span>
                      )}

                      {isUnread ? (
                        <span className="nc-state-pill pill-unread" data-testid={`badge-unread-${n._id}`}>
                          Unread
                        </span>
                      ) : (
                        <span className="nc-state-pill pill-read" data-testid={`badge-read-${n._id}`}>
                          Read
                        </span>
                      )}

                      {severityInfo && (
                        <span
                          className={`severity-pill ${severityInfo.pillClass}`}
                          title={severityInfo.tooltip}
                          data-testid={`severity-badge-${n._id}`}
                        >
                          <span className="severity-band-label">{severityInfo.label}</span>
                          <span className="severity-score-val">{severityInfo.scoreFormatted}</span>
                        </span>
                      )}
                    </div>

                    <div className="nc-card-time">
                      <Clock size={12} />
                      <span>{formatDate(n.createdAt)}</span>
                    </div>
                  </div>

                  <div className="nc-card-body">
                    <h3 className="nc-card-title">{n.title}</h3>
                    <p className="nc-card-message">{n.message}</p>
                  </div>

                  <div className="nc-card-footer">
                    {/* Email Delivery Status Indicator */}
                    <div className="nc-email-status-row" data-testid={`email-status-box-${n._id}`}>
                      {n.emailStatus === "sent" && (
                        <div className="email-status-pill email-sent" title={`Email delivered on ${formatDate(n.emailSentAt)}`}>
                          <CheckCircle2 size={13} />
                          <span>Email Sent ({formatDate(n.emailSentAt)})</span>
                        </div>
                      )}

                      {n.emailStatus === "pending" && (
                        <div className="email-status-pill email-pending" title="Email delivery queued or pending">
                          <Clock size={13} />
                          <span>Email Pending {n.emailAttemptCount > 0 ? `(Attempt ${n.emailAttemptCount})` : ""}</span>
                        </div>
                      )}

                      {n.emailStatus === "failed" && (
                        <div className="email-failed-container">
                          <div
                            className="email-status-pill email-failed"
                            title={n.emailLastError ? `Error: ${n.emailLastError}` : "Email delivery failed"}
                          >
                            <AlertCircle size={13} />
                            <span>
                              Email Failed ({n.emailAttemptCount || 0}/5 attempts)
                            </span>
                          </div>

                          <button
                            type="button"
                            className="btn-retry-email"
                            onClick={() => handleRetryEmail(n._id, n.emailAttemptCount || 0)}
                            disabled={inAction || maxRetriesReached}
                            data-testid={`retry-email-btn-${n._id}`}
                            title={
                              maxRetriesReached
                                ? "Maximum retry limit (5) reached"
                                : "Retry sending email alert"
                            }
                          >
                            <RefreshCw size={12} className={inAction ? "spinning" : ""} />
                            <span>{inAction ? "Retrying..." : maxRetriesReached ? "Retry Limit Reached" : "Retry Email"}</span>
                          </button>
                        </div>
                      )}

                      {n.emailStatus === "unconfigured" && (
                        <div
                          className="email-status-pill email-unconfigured"
                          title="SMTP transport is not configured on the server. Email delivery skipped safely."
                        >
                          <Mail size={13} />
                          <span>SMTP Unconfigured</span>
                        </div>
                      )}
                    </div>

                    {/* Actions: Mark as Read & Open Hotspot */}
                    <div className="nc-card-actions">
                      {isUnread && (
                        <button
                          type="button"
                          className="btn-mark-read"
                          onClick={() => handleMarkAsRead(n._id)}
                          disabled={inAction}
                          data-testid={`mark-read-btn-${n._id}`}
                          title="Mark this notification as read"
                        >
                          <CheckCircle2 size={13} />
                          <span>{inAction ? "Updating..." : "Mark as Read"}</span>
                        </button>
                      )}

                      {n.hotspotId && onNavigateToHotspot && (
                        <button
                          type="button"
                          className="btn-view-hotspot-link"
                          onClick={() => onNavigateToHotspot(n.hotspotId)}
                          data-testid={`view-hotspot-link-${n._id}`}
                          title="Open associated cluster in Hotspots dashboard"
                        >
                          <ExternalLink size={13} />
                          <span>View Hotspot</span>
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Pagination Section */}
        {notifications.length > 0 && (
          <div className="nc-pagination" data-testid="nc-pagination">
            <span className="nc-page-summary">
              Showing <strong>{notifications.length}</strong> of <strong>{totalNotifications}</strong> notifications
            </span>

            <div className="nc-pagination-controls">
              <button
                type="button"
                className="pagination-btn"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                data-testid="nc-page-prev"
                aria-label="Previous notification page"
              >
                <ChevronLeft size={16} /> Prev
              </button>

              <span className="nc-page-indicator">
                Page {page} of {totalPages}
              </span>

              <button
                type="button"
                className="pagination-btn"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                data-testid="nc-page-next"
                aria-label="Next notification page"
              >
                Next <ChevronRight size={16} />
              </button>
            </div>

            <div className="nc-limit-selector">
              <label htmlFor="nc-limit-select">Per page:</label>
              <select
                id="nc-limit-select"
                value={limit}
                onChange={(e) => {
                  setLimit(Number(e.target.value));
                  setPage(1);
                }}
              >
                <option value={10}>10</option>
                <option value={20}>20</option>
                <option value={50}>50</option>
              </select>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default NotificationCenter;
