import React, { useState, useEffect, useCallback } from "react";
import {
  Flame,
  RefreshCw,
  Filter,
  MapPin,
  Clock,
  AlertTriangle,
  CheckCircle2,
  ThumbsUp,
  X,
  ExternalLink,
  Layers,
  Activity,
  AlertCircle,
  HelpCircle,
  ChevronLeft,
  ChevronRight,
  ShieldCheck,
  Building2,
  FileText
} from "lucide-react";
import { fetchHotspots, fetchHotspotById, runHotspotRefresh } from "../api/api";
import "./HotspotsSection.css";

const CANONICAL_CATEGORIES = [
  "all",
  "pothole",
  "road_damage",
  "garbage",
  "street_light",
  "water_leak",
  "sewage",
  "traffic_signal",
  "other"
];

const DEPARTMENTS = [
  "all",
  "Roads & Infrastructure",
  "Waste Management",
  "Street Lighting",
  "Water Services",
  "Public Works"
];

const STATUS_OPTIONS = [
  { value: "all", label: "All Statuses" },
  { value: "active", label: "Active" },
  { value: "escalating", label: "Escalating" },
  { value: "resolving", label: "Resolving" },
  { value: "resolved", label: "Resolved" },
  { value: "dismissed", label: "Dismissed" }
];

const SORT_OPTIONS = [
  { value: "lastDetectedAt", label: "Last Detected" },
  { value: "distinctDefectCount", label: "Distinct Defects" },
  { value: "totalReportCount", label: "Total Reports" },
  { value: "meanSeverity", label: "Mean Severity" },
  { value: "createdAt", label: "First Detected" }
];

/**
 * Resolves severity score out of 10 into Low, Medium, and High bands.
 * Matches existing admin severity visualization system.
 */
function getSeverityBadgeInfo(severity) {
  if (severity === null || severity === undefined || typeof severity !== "number" || isNaN(severity)) {
    return {
      band: "unavailable",
      label: "N/A",
      scoreFormatted: "—",
      pillClass: "severity-pill-unavailable",
      tooltip: "Mean severity unavailable (no scored reports in cluster)"
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
      tooltip: `Mean Severity: ${scoreFormatted} (High band) — Rule-based heuristic estimate`
    };
  } else if (score >= 4.0) {
    return {
      band: "medium",
      label: "Medium",
      scoreFormatted,
      pillClass: "severity-pill-medium",
      tooltip: `Mean Severity: ${scoreFormatted} (Medium band) — Rule-based heuristic estimate`
    };
  } else {
    return {
      band: "low",
      label: "Low",
      scoreFormatted,
      pillClass: "severity-pill-low",
      tooltip: `Mean Severity: ${scoreFormatted} (Low band) — Rule-based heuristic estimate`
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

const HotspotsSection = ({ initialSelectedHotspotId, onClearInitialHotspotId }) => {
  const [hotspots, setHotspots] = useState([]);

  const [totalHotspots, setTotalHotspots] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);

  // Filters state
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [departmentFilter, setDepartmentFilter] = useState("all");
  const [sortBy, setSortBy] = useState("lastDetectedAt");
  const [sortOrder, setSortOrder] = useState("desc");

  // Loading & error state
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Refresh job state
  const [refreshing, setRefreshing] = useState(false);
  const [refreshAlert, setRefreshAlert] = useState(null);

  // Selected hotspot for detail modal
  const [selectedHotspotId, setSelectedHotspotId] = useState(null);
  const [hotspotDetail, setHotspotDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(null);

  // Fetch hotspots list
  const loadHotspots = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const params = {
        page,
        limit,
        sortBy,
        order: sortOrder
      };

      if (categoryFilter !== "all") params.category = categoryFilter;
      if (statusFilter !== "all") params.status = statusFilter;
      if (departmentFilter !== "all") params.department = departmentFilter;

      const res = await fetchHotspots(params);
      const data = res.data;

      setHotspots(Array.isArray(data.hotspots) ? data.hotspots : []);
      setTotalHotspots(typeof data.total === "number" ? data.total : (data.hotspots?.length || 0));
      setTotalPages(data.totalPages || 1);
    } catch (err) {
      console.error("Error fetching hotspots:", err);
      setError(
        err.response?.data?.message ||
        "Failed to load hotspot clusters. Please verify backend service and authentication."
      );
    } finally {
      setLoading(false);
    }
  }, [page, limit, categoryFilter, statusFilter, departmentFilter, sortBy, sortOrder]);

  useEffect(() => {
    loadHotspots();
  }, [loadHotspots]);

  // Handle manual refresh request
  const handleRunRefresh = async () => {
    if (refreshing) return; // Prevent duplicate clicks
    setRefreshing(true);
    setRefreshAlert(null);

    try {
      const res = await runHotspotRefresh({});
      const summary = res.data?.summary || {};
      const durationMs = res.data?.durationMs ? ` in ${res.data.durationMs}ms` : "";

      setRefreshAlert({
        type: "success",
        message: `DBSCAN clustering completed successfully${durationMs}! Created: ${summary.createdCount ?? 0}, Updated: ${summary.updatedCount ?? 0}, Resolving: ${summary.resolvingCount ?? 0}, Resolved: ${summary.resolvedCount ?? 0}.`
      });

      // Reload hotspots after successful refresh
      loadHotspots();
    } catch (err) {
      if (err.response?.status === 409) {
        setRefreshAlert({
          type: "warning",
          message:
            err.response.data?.message ||
            "Hotspot refresh job is currently running. Please wait for the current run to complete."
        });
      } else {
        setRefreshAlert({
          type: "error",
          message: err.response?.data?.message || "Failed to trigger hotspot refresh job. Please try again."
        });
      }
    } finally {
      setRefreshing(false);
    }
  };

  // Open detail modal and fetch full details
  const handleOpenDetail = async (id) => {
    setSelectedHotspotId(id);
    setHotspotDetail(null);
    setDetailLoading(true);
    setDetailError(null);

    try {
      const res = await fetchHotspotById(id);
      setHotspotDetail(res.data.hotspot || null);
    } catch (err) {
      console.error("Error fetching hotspot details:", err);
      setDetailError(err.response?.data?.message || "Failed to load hotspot details.");
    } finally {
      setDetailLoading(false);
    }
  };

  const handleCloseDetail = () => {
    setSelectedHotspotId(null);
    setHotspotDetail(null);
    setDetailError(null);
  };

  useEffect(() => {
    if (initialSelectedHotspotId) {
      handleOpenDetail(initialSelectedHotspotId);
      if (onClearInitialHotspotId) {
        onClearInitialHotspotId();
      }
    }
  }, [initialSelectedHotspotId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Derived metrics from loaded hotspots
  const activeCount = hotspots.filter((h) => h.status === "active").length;
  const escalatingCount = hotspots.filter((h) => h.status === "escalating").length;
  const resolvingCount = hotspots.filter((h) => h.status === "resolving").length;
  const totalClusteredReports = hotspots.reduce(
    (acc, h) => acc + (h.totalReportCount || h.totalReportsCount || 0),
    0
  );

  return (
    <div className="hotspots-section" data-testid="hotspots-section">
      {/* Hotspots Summary Metrics Cards */}
      <section className="hotspot-metrics-grid" aria-label="Hotspots Overview Metrics">
        <div
          className={`hotspot-metric-card total ${statusFilter === "all" ? "active-card" : ""}`}
          onClick={() => { setStatusFilter("all"); setPage(1); }}
          role="button"
          tabIndex={0}
          title="All detected hotspot clusters"
          data-testid="hotspot-metric-total"
        >
          <div className="metric-header">
            <span className="metric-label">Total Hotspots</span>
            <Flame size={20} className="metric-icon flame-icon" />
          </div>
          <div className="metric-value">{totalHotspots}</div>
          <span className="metric-hint">DBSCAN defect clusters</span>
        </div>

        <div
          className={`hotspot-metric-card active ${statusFilter === "active" ? "active-card" : ""}`}
          onClick={() => { setStatusFilter("active"); setPage(1); }}
          role="button"
          tabIndex={0}
          title="Active high-density defect hotspots"
          data-testid="hotspot-metric-active"
        >
          <div className="metric-header">
            <span className="metric-label">Active Clusters</span>
            <Activity size={20} className="metric-icon active-icon" />
          </div>
          <div className="metric-value">{activeCount}</div>
          <span className="metric-hint">Dense active defect clusters</span>
        </div>

        <div
          className={`hotspot-metric-card escalating ${statusFilter === "escalating" ? "active-card" : ""}`}
          onClick={() => { setStatusFilter("escalating"); setPage(1); }}
          role="button"
          tabIndex={0}
          title="Rapidly growing defect clusters"
          data-testid="hotspot-metric-escalating"
        >
          <div className="metric-header">
            <span className="metric-label">Escalating</span>
            <AlertTriangle size={20} className="metric-icon escalating-icon" />
          </div>
          <div className="metric-value">{escalatingCount}</div>
          <span className="metric-hint">≥50% report growth detected</span>
        </div>

        <div
          className={`hotspot-metric-card resolving ${statusFilter === "resolving" ? "active-card" : ""}`}
          onClick={() => { setStatusFilter("resolving"); setPage(1); }}
          role="button"
          tabIndex={0}
          title="Clusters dropping below active sample threshold"
          data-testid="hotspot-metric-resolving"
        >
          <div className="metric-header">
            <span className="metric-label">Resolving</span>
            <Clock size={20} className="metric-icon resolving-icon" />
          </div>
          <div className="metric-value">{resolvingCount}</div>
          <span className="metric-hint">Conservative clearing state</span>
        </div>

        <div
          className="hotspot-metric-card reports"
          title="Total citizen reports represented in clusters"
          data-testid="hotspot-metric-reports"
        >
          <div className="metric-header">
            <span className="metric-label">Clustered Reports</span>
            <Layers size={20} className="metric-icon reports-icon" />
          </div>
          <div className="metric-value">{totalClusteredReports}</div>
          <span className="metric-hint">Citizen report volume aggregated</span>
        </div>
      </section>

      {/* Refresh Feedback Alert Banner */}
      {refreshAlert && (
        <div className={`hotspot-alert-banner ${refreshAlert.type}`} role="alert">
          <div className="alert-content">
            {refreshAlert.type === "success" && <CheckCircle2 size={18} className="alert-icon" />}
            {refreshAlert.type === "warning" && <AlertTriangle size={18} className="alert-icon" />}
            {refreshAlert.type === "error" && <AlertCircle size={18} className="alert-icon" />}
            <span>{refreshAlert.message}</span>
          </div>
          <button
            className="alert-close-btn"
            onClick={() => setRefreshAlert(null)}
            aria-label="Dismiss alert"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* Toolbar & Filter Controls */}
      <section className="hotspot-toolbar">
        <div className="toolbar-left">
          <button
            type="button"
            className={`btn-refresh-hotspots ${refreshing ? "loading" : ""}`}
            onClick={handleRunRefresh}
            disabled={refreshing}
            data-testid="refresh-hotspots-btn"
            title="Execute DBSCAN clustering job"
          >
            <RefreshCw size={16} className={refreshing ? "spinning" : ""} />
            <span>{refreshing ? "Clustering in Progress..." : "Refresh Hotspots"}</span>
          </button>
        </div>

        <div className="toolbar-filters">
          <div className="filter-group">
            <Filter size={15} className="filter-icon" />
            <label htmlFor="hotspot-category-select">Category:</label>
            <select
              id="hotspot-category-select"
              data-testid="hotspot-category-filter"
              value={categoryFilter}
              onChange={(e) => {
                setCategoryFilter(e.target.value);
                setPage(1);
              }}
            >
              {CANONICAL_CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {cat === "all" ? "All Categories" : cat.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
                </option>
              ))}
            </select>
          </div>

          <div className="filter-group">
            <label htmlFor="hotspot-status-select">Status:</label>
            <select
              id="hotspot-status-select"
              data-testid="hotspot-status-filter"
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(1);
              }}
            >
              {STATUS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div className="filter-group">
            <label htmlFor="hotspot-dept-select">Department:</label>
            <select
              id="hotspot-dept-select"
              data-testid="hotspot-dept-filter"
              value={departmentFilter}
              onChange={(e) => {
                setDepartmentFilter(e.target.value);
                setPage(1);
              }}
            >
              {DEPARTMENTS.map((dept) => (
                <option key={dept} value={dept}>
                  {dept === "all" ? "All Departments" : dept}
                </option>
              ))}
            </select>
          </div>

          <div className="filter-group">
            <label htmlFor="hotspot-sort-select">Sort By:</label>
            <select
              id="hotspot-sort-select"
              data-testid="hotspot-sort-filter"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
            >
              {SORT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn-sort-order"
              onClick={() => setSortOrder((prev) => (prev === "desc" ? "asc" : "desc"))}
              title={`Sort order: ${sortOrder === "desc" ? "Descending" : "Ascending"}`}
              aria-label="Toggle sort order"
            >
              {sortOrder === "desc" ? "↓" : "↑"}
            </button>
          </div>
        </div>
      </section>

      {/* Main Table / Content Section */}
      <section className="hotspot-table-container">
        {loading ? (
          <div className="loading-state" data-testid="hotspot-loading-state">
            <div className="spinner" />
            <p>Loading hotspot clusters...</p>
          </div>
        ) : error ? (
          <div className="error-state" data-testid="hotspot-error-state">
            <AlertCircle size={36} className="error-icon" />
            <h3>Failed to Load Hotspots</h3>
            <p>{error}</p>
            <button type="button" className="btn-retry" onClick={loadHotspots}>
              <RefreshCw size={14} /> Retry
            </button>
          </div>
        ) : hotspots.length === 0 ? (
          <div className="empty-state" data-testid="hotspot-empty-state">
            <Flame size={40} className="empty-icon" />
            <h3>No Hotspots Detected</h3>
            <p>
              No defect clusters match the current filters. Click "Refresh Hotspots" to execute DBSCAN spatial clustering on recent civic reports.
            </p>
            <button type="button" className="btn-retry" onClick={handleRunRefresh} disabled={refreshing}>
              <RefreshCw size={14} className={refreshing ? "spinning" : ""} /> Refresh Hotspots Now
            </button>
          </div>
        ) : (
          <>
            <div className="hotspots-table-wrapper">
              <table className="hotspots-table" data-testid="hotspots-table">
                <thead>
                  <tr>
                    <th>Category</th>
                    <th>Department</th>
                    <th>Status</th>
                    <th>Centroid [Lng, Lat]</th>
                    <th>Defects</th>
                    <th>Reports</th>
                    <th>Votes</th>
                    <th>Severity</th>
                    <th>Last Detected</th>
                    <th className="actions-header">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {hotspots.map((hotspot) => {
                    const coords = hotspot.centroid?.coordinates || [0, 0];
                    const severityInfo = getSeverityBadgeInfo(hotspot.meanSeverity);

                    return (
                      <tr key={hotspot._id} data-testid={`hotspot-row-${hotspot._id}`}>
                        <td>
                          <span className={`category-tag category-${hotspot.category}`}>
                            {hotspot.category?.replace(/_/g, " ")}
                          </span>
                        </td>
                        <td className="dept-cell">{hotspot.department || "Public Works"}</td>
                        <td>
                          <span className={`status-pill status-${hotspot.status}`}>
                            {hotspot.status}
                          </span>
                        </td>
                        <td className="coords-cell">
                          <span className="coords-wrapper" title={`Centroid coordinates: [${coords[0]}, ${coords[1]}]`}>
                            <MapPin size={13} className="coords-icon" />
                            {coords[0]?.toFixed(4)}, {coords[1]?.toFixed(4)}
                          </span>
                        </td>
                        <td>
                          <span className="count-pill distinct-pill" title={`${hotspot.distinctDefectCount} distinct defects`}>
                            {hotspot.distinctDefectCount}
                          </span>
                        </td>
                        <td>
                          <span
                            className="count-pill reports-pill"
                            title={`${hotspot.totalReportCount ?? hotspot.totalReportsCount} citizen reports`}
                          >
                            {hotspot.totalReportCount ?? hotspot.totalReportsCount}
                          </span>
                        </td>
                        <td>
                          <span className="votes-wrapper">
                            <ThumbsUp size={13} className="votes-icon" />
                            {hotspot.totalVotes || 0}
                          </span>
                        </td>
                        <td>
                          <span className={`severity-badge ${severityInfo.pillClass}`} title={severityInfo.tooltip}>
                            {severityInfo.scoreFormatted}
                          </span>
                        </td>
                        <td className="date-cell">{formatDate(hotspot.lastDetectedAt)}</td>
                        <td className="actions-cell">
                          <button
                            type="button"
                            className="btn-view-hotspot"
                            onClick={() => handleOpenDetail(hotspot._id)}
                            data-testid={`view-hotspot-btn-${hotspot._id}`}
                            title="View cluster details & constituent issues"
                          >
                            <ExternalLink size={14} />
                            <span>Details</span>
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination Controls */}
            <div className="hotspot-pagination">
              <span className="page-summary">
                Showing <strong>{hotspots.length}</strong> of <strong>{totalHotspots}</strong> hotspots
              </span>

              <div className="pagination-buttons">
                <button
                  type="button"
                  className="pagination-btn"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  data-testid="hotspot-page-prev"
                  aria-label="Previous page"
                >
                  <ChevronLeft size={16} /> Prev
                </button>
                <span className="page-indicator">
                  Page {page} of {totalPages}
                </span>
                <button
                  type="button"
                  className="pagination-btn"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                  data-testid="hotspot-page-next"
                  aria-label="Next page"
                >
                  Next <ChevronRight size={16} />
                </button>
              </div>

              <div className="page-limit-selector">
                <label htmlFor="hotspot-limit-select">Per page:</label>
                <select
                  id="hotspot-limit-select"
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
          </>
        )}
      </section>

      {/* Hotspot Details Modal */}
      {selectedHotspotId && (
        <div className="modal-overlay" onClick={handleCloseDetail} data-testid="hotspot-detail-modal-overlay">
          <div
            className="hotspot-detail-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-hotspot-title"
          >
            <div className="modal-header">
              <div className="modal-header-left">
                <span className="modal-cluster-tag">DBSCAN Cluster</span>
                <h2 id="modal-hotspot-title" className="modal-title">
                  Hotspot #{selectedHotspotId}
                </h2>
              </div>
              <button
                type="button"
                className="btn-modal-close"
                onClick={handleCloseDetail}
                data-testid="hotspot-modal-close-btn"
                aria-label="Close modal"
              >
                <X size={20} />
              </button>
            </div>

            <div className="modal-body">
              {detailLoading ? (
                <div className="loading-state">
                  <div className="spinner" />
                  <p>Loading cluster details & constituent issues...</p>
                </div>
              ) : detailError ? (
                <div className="error-state">
                  <AlertCircle size={32} className="error-icon" />
                  <h3>Failed to Load Details</h3>
                  <p>{detailError}</p>
                </div>
              ) : hotspotDetail ? (
                <>
                  {/* Top Cluster Metadata Cards */}
                  <div className="detail-metrics-grid">
                    <div className="detail-metric-card">
                      <span className="metric-title">Category</span>
                      <span className={`category-tag category-${hotspotDetail.category}`}>
                        {hotspotDetail.category?.replace(/_/g, " ")}
                      </span>
                    </div>

                    <div className="detail-metric-card">
                      <span className="metric-title">Department</span>
                      <span className="metric-text">{hotspotDetail.department || "Public Works"}</span>
                    </div>

                    <div className="detail-metric-card">
                      <span className="metric-title">Lifecycle Status</span>
                      <span className={`status-pill status-${hotspotDetail.status}`}>
                        {hotspotDetail.status}
                      </span>
                    </div>

                    <div className="detail-metric-card">
                      <span className="metric-title">Centroid Coordinates</span>
                      <span className="metric-text coords-text">
                        <MapPin size={13} />
                        {hotspotDetail.centroid?.coordinates
                          ? `[${hotspotDetail.centroid.coordinates[0]}, ${hotspotDetail.centroid.coordinates[1]}]`
                          : "—"}
                      </span>
                    </div>

                    <div className="detail-metric-card">
                      <span className="metric-title">Cluster Extent</span>
                      <span className="metric-text">
                        ≈ {hotspotDetail.radiusMeters ? `${hotspotDetail.radiusMeters} m` : "Compact point"}
                      </span>
                    </div>

                    <div className="detail-metric-card">
                      <span className="metric-title">Distinct Defects</span>
                      <span className="metric-number">{hotspotDetail.distinctDefectCount}</span>
                    </div>

                    <div className="detail-metric-card">
                      <span className="metric-title">Total Citizen Reports</span>
                      <span className="metric-number">{hotspotDetail.totalReportCount}</span>
                    </div>

                    <div className="detail-metric-card">
                      <span className="metric-title">Total Votes</span>
                      <span className="metric-number">{hotspotDetail.totalVotes || 0}</span>
                    </div>

                    <div className="detail-metric-card">
                      <span className="metric-title">Mean Heuristic Severity</span>
                      <span className="metric-text">
                        {(() => {
                          const sInfo = getSeverityBadgeInfo(hotspotDetail.meanSeverity);
                          return (
                            <span className={`severity-badge ${sInfo.pillClass}`}>
                              {sInfo.scoreFormatted} ({sInfo.label})
                            </span>
                          );
                        })()}
                      </span>
                    </div>
                  </div>

                  {/* Detection Timestamps & Alert Bookkeeping */}
                  <div className="detail-bookkeeping-panel">
                    <h3 className="section-subtitle">
                      <Clock size={16} /> Lifecycle & Alert Deduplication Bookkeeping
                    </h3>
                    <div className="bookkeeping-grid">
                      <div>
                        <strong>First Detected:</strong> {formatDate(hotspotDetail.firstDetectedAt)}
                      </div>
                      <div>
                        <strong>Last Detected:</strong> {formatDate(hotspotDetail.lastDetectedAt)}
                      </div>
                      <div>
                        <strong>Initial Alert Logged:</strong>{" "}
                        {hotspotDetail.alertSent ? (
                          <span className="badge-logged">Logged ({formatDate(hotspotDetail.alertSentAt)})</span>
                        ) : (
                          <span className="badge-unlogged">Not Logged</span>
                        )}
                      </div>
                      <div>
                        <strong>Escalation Alert Logged:</strong>{" "}
                        {hotspotDetail.escalatedAlertSentAt ? (
                          <span className="badge-logged">
                            Escalated ({formatDate(hotspotDetail.escalatedAlertSentAt)})
                          </span>
                        ) : (
                          <span className="badge-unlogged">None</span>
                        )}
                      </div>
                      <div>
                        <strong>Last Alert Report Count:</strong> {hotspotDetail.lastAlertIssueCount || 0}
                      </div>
                    </div>
                    <p className="bookkeeping-note">
                      Notice: Alert records indicate candidate municipal eligibility; external communications (SMS/email) are decoupled and require separate dispatch pipelines.
                    </p>
                  </div>



                  {/* Associated Constituent Issues */}
                  <div className="detail-issues-section">
                    <h3 className="section-subtitle">
                      <Layers size={16} /> Constituent Citizen Reports (
                      {Array.isArray(hotspotDetail.issues) ? hotspotDetail.issues.length : 0})
                    </h3>

                    {!hotspotDetail.issues || hotspotDetail.issues.length === 0 ? (
                      <p className="no-issues-text">No constituent issue summaries returned by server.</p>
                    ) : (
                      <div className="constituent-issues-list">
                        {hotspotDetail.issues.map((iss) => (
                          <div key={iss._id} className="constituent-issue-card" data-testid={`constituent-issue-${iss._id}`}>
                            <div className="card-top">
                              <span className="issue-type-badge">{iss.type}</span>
                              <span className={`issue-status-badge status-${iss.status}`}>{iss.status}</span>
                              <span className="issue-id">ID: #{iss._id}</span>
                            </div>
                            <p className="issue-desc">{iss.description}</p>
                            <div className="card-footer-meta">
                              <span>
                                <MapPin size={12} />
                                {iss.location?.coordinates
                                  ? `${iss.location.coordinates[0]?.toFixed(4)}, ${iss.location.coordinates[1]?.toFixed(4)}`
                                  : "—"}
                              </span>
                              <span>Reporter: {iss.userId?.fullName || "Citizen"}</span>
                              <span>Votes: {iss.votes || 0}</span>
                              {iss.severity !== undefined && iss.severity !== null && (
                                <span>Severity: {iss.severity}/10</span>
                              )}
                              <span>Created: {formatDate(iss.createdAt)}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default HotspotsSection;
