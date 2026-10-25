import React, { useState } from "react";
import {
  TrendingUp,
  BarChart3,
  Clock,
  CheckCircle2,
  AlertTriangle,
  FileText,
  Layers,
  Flame,
  RefreshCw,
  Building2,
  Calendar,
  ShieldCheck,
  HelpCircle
} from "lucide-react";
import "./AnalyticsSection.css";

const DAY_OPTIONS = [
  { value: 14, label: "14 Days" },
  { value: 30, label: "30 Days" },
  { value: 60, label: "60 Days" },
  { value: 90, label: "90 Days" }
];

export default function AnalyticsSection({
  analytics,
  loading,
  error,
  selectedDays,
  onDaysChange,
  onRefresh
}) {
  const [hoveredTrend, setHoveredTrend] = useState(null);

  if (loading && !analytics) {
    return (
      <div className="analytics-loading-box" data-testid="analytics-loading">
        <RefreshCw size={32} className="spin-icon" />
        <p>Calculating database-backed metrics and aggregation pipelines...</p>
      </div>
    );
  }

  if (error && !analytics) {
    return (
      <div className="analytics-error-box" data-testid="analytics-error">
        <AlertTriangle size={36} className="error-icon" />
        <h3>Failed to Load Analytics</h3>
        <p>{error}</p>
        <button
          type="button"
          className="btn-retry-analytics"
          onClick={() => onRefresh && onRefresh()}
        >
          <RefreshCw size={16} /> Retry
        </button>
      </div>
    );
  }

  const summary = analytics?.summary || {
    totalIssues: 0,
    openIssues: 0,
    resolvedIssues: 0,
    reportedIssues: 0,
    inProgressIssues: 0,
    needsReviewIssues: 0,
    resolutionRate: 0,
    resolutionRateFormatted: "0.0%"
  };

  const mttr = analytics?.mttr || {
    avgHours: null,
    sampleSize: 0,
    formatted: "N/A"
  };

  const breakdowns = analytics?.breakdowns || {
    byStatus: {},
    byCategory: [],
    byDepartment: []
  };

  const hotspots = analytics?.hotspots || {
    total: 0,
    active: 0,
    totalDistinctDefects: 0,
    avgSeverity: null
  };

  const trend = analytics?.trend || {
    data: [],
    days: 30
  };

  const isCollectionEmpty = summary.totalIssues === 0;

  // Compute maximum count in trend data for chart scaling
  const maxTrendValue = Math.max(
    1,
    ...(trend.data || []).map((d) => Math.max(d.created || 0, d.resolved || 0))
  );

  return (
    <div className="analytics-section-wrapper" data-testid="analytics-section">
      {/* Analytics Control Header */}
      <div className="analytics-controls-header">
        <div className="analytics-title-group">
          <div className="title-with-badge">
            <h2>
              <BarChart3 size={24} className="title-icon" />
              Municipal Performance Analytics
            </h2>
            <span className="badge-live-db">Database-Backed</span>
          </div>
          <p className="analytics-subtitle">
            Aggregation-derived metrics, mean resolution speed (MTTR), and daily issue trends.
          </p>
        </div>

        <div className="analytics-actions-group">
          <div className="days-selector-pills" role="radiogroup" aria-label="Trend Timeframe">
            {DAY_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`pill-btn ${selectedDays === opt.value ? "active" : ""}`}
                onClick={() => onDaysChange && onDaysChange(opt.value)}
                data-testid={`days-pill-${opt.value}`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            className="btn-analytics-refresh"
            onClick={() => onRefresh && onRefresh()}
            disabled={loading}
            title="Refresh database analytics"
            data-testid="btn-analytics-refresh"
          >
            <RefreshCw size={16} className={loading ? "spin-icon" : ""} />
            <span>{loading ? "Refreshing..." : "Refresh"}</span>
          </button>
        </div>
      </div>

      {/* Primary KPI Metric Cards Grid */}
      <div className="analytics-kpi-grid">
        {/* Card 1: Total Issues */}
        <div className="kpi-card card-total" data-testid="kpi-total">
          <div className="kpi-top">
            <span className="kpi-label">Total Issues</span>
            <FileText size={20} className="kpi-icon" />
          </div>
          <div className="kpi-value">{summary.totalIssues}</div>
          <span className="kpi-caption">All recorded community defects</span>
        </div>

        {/* Card 2: Open Issues */}
        <div className="kpi-card card-open" data-testid="kpi-open">
          <div className="kpi-top">
            <span className="kpi-label">Open Pipeline</span>
            <AlertTriangle size={20} className="kpi-icon icon-warning" />
          </div>
          <div className="kpi-value">{summary.openIssues}</div>
          <span className="kpi-caption">
            {summary.reportedIssues} reported + {summary.inProgressIssues} in progress
          </span>
        </div>

        {/* Card 3: Resolved Issues */}
        <div className="kpi-card card-resolved" data-testid="kpi-resolved">
          <div className="kpi-top">
            <span className="kpi-label">Resolved Issues</span>
            <CheckCircle2 size={20} className="kpi-icon icon-success" />
          </div>
          <div className="kpi-value">{summary.resolvedIssues}</div>
          <span className="kpi-caption">Successfully closed & verified</span>
        </div>

        {/* Card 4: Resolution Rate */}
        <div className="kpi-card card-rate" data-testid="kpi-rate">
          <div className="kpi-top">
            <span className="kpi-label">Resolution Rate</span>
            <TrendingUp size={20} className="kpi-icon icon-accent" />
          </div>
          <div className="kpi-value">{summary.resolutionRateFormatted}</div>
          <div className="kpi-progress-bar">
            <div
              className="kpi-progress-fill"
              style={{ width: `${Math.min(100, Math.max(0, summary.resolutionRate * 100))}%` }}
            />
          </div>
          <span className="kpi-caption">Resolved ÷ total issues denominator</span>
        </div>

        {/* Card 5: Average Resolution Time (MTTR) */}
        <div className="kpi-card card-mttr" data-testid="kpi-mttr">
          <div className="kpi-top">
            <span className="kpi-label">Avg Resolution (MTTR)</span>
            <Clock size={20} className="kpi-icon icon-clock" />
          </div>
          <div className="kpi-value">{mttr.formatted}</div>
          <span className="kpi-caption">
            {mttr.sampleSize > 0
              ? `Sample size: ${mttr.sampleSize} verified record${mttr.sampleSize === 1 ? "" : "s"}`
              : "No verified resolvedAt records"}
          </span>
        </div>
      </div>

      {isCollectionEmpty ? (
        <div className="analytics-empty-state" data-testid="analytics-empty">
          <FileText size={48} className="empty-icon" />
          <h3>No Civic Defect Data Available</h3>
          <p>The issue database is currently empty. As citizens report issues and remediation progresses, analytics will display here automatically.</p>
        </div>
      ) : (
        <>
          {/* Daily Trend Time Series Section */}
          <div className="analytics-card trend-section" data-testid="analytics-trend-card">
            <div className="card-header-row">
              <div className="card-header-left">
                <h3>
                  <TrendingUp size={18} />
                  Daily Activity Trend ({trend.days || selectedDays} Days)
                </h3>
                <span className="card-subtitle">
                  Daily intake (reported) vs completions (resolved) aggregated by UTC calendar boundaries
                </span>
              </div>
              <div className="trend-legend">
                <span className="legend-item legend-created">
                  <span className="legend-dot dot-created" /> Reported
                </span>
                <span className="legend-item legend-resolved">
                  <span className="legend-dot dot-resolved" /> Resolved
                </span>
              </div>
            </div>

            {/* Pure SVG Bar/Column Visualization */}
            <div className="trend-chart-container">
              {hoveredTrend && (
                <div className="trend-tooltip">
                  <strong>{hoveredTrend.date}</strong>
                  <div>Reported: {hoveredTrend.created}</div>
                  <div>Resolved: {hoveredTrend.resolved}</div>
                </div>
              )}

              <div className="trend-bars-scroll">
                <div className="trend-bars-track">
                  {(trend.data || []).map((day) => {
                    const createdHeight = (day.created / maxTrendValue) * 100;
                    const resolvedHeight = (day.resolved / maxTrendValue) * 100;

                    return (
                      <div
                        key={day.date}
                        className="trend-day-col"
                        onMouseEnter={() => setHoveredTrend(day)}
                        onMouseLeave={() => setHoveredTrend(null)}
                      >
                        <div className="bar-pair">
                          <div
                            className="bar bar-created"
                            style={{ height: `${Math.max(createdHeight, day.created > 0 ? 8 : 0)}%` }}
                            title={`${day.date}: ${day.created} reported`}
                          />
                          <div
                            className="bar bar-resolved"
                            style={{ height: `${Math.max(resolvedHeight, day.resolved > 0 ? 8 : 0)}%` }}
                            title={`${day.date}: ${day.resolved} resolved`}
                          />
                        </div>
                        <span className="day-label">{day.date.slice(5)}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* Breakdown Section: Categories & Departments */}
          <div className="analytics-breakdowns-grid">
            {/* Category Breakdown */}
            <div className="analytics-card breakdown-card" data-testid="breakdown-category">
              <div className="card-header-row">
                <h3>
                  <Layers size={18} />
                  Issues by Category
                </h3>
                <span className="card-badge">{breakdowns.byCategory.length} Categories</span>
              </div>

              <div className="breakdown-list">
                {breakdowns.byCategory.length === 0 ? (
                  <p className="text-muted">No category data recorded.</p>
                ) : (
                  breakdowns.byCategory.map((cat) => (
                    <div key={cat.category} className="breakdown-item">
                      <div className="breakdown-item-header">
                        <span className="breakdown-name">{cat.category}</span>
                        <span className="breakdown-numbers">
                          <strong>{cat.count}</strong> ({cat.percentage})
                        </span>
                      </div>
                      <div className="breakdown-bar">
                        <div
                          className="breakdown-bar-fill fill-category"
                          style={{ width: cat.percentage }}
                        />
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Department Breakdown */}
            <div className="analytics-card breakdown-card" data-testid="breakdown-department">
              <div className="card-header-row">
                <h3>
                  <Building2 size={18} />
                  Issues by Department
                </h3>
                <span className="card-badge">{breakdowns.byDepartment.length} Departments</span>
              </div>

              <div className="breakdown-list">
                {breakdowns.byDepartment.length === 0 ? (
                  <p className="text-muted">No department data recorded.</p>
                ) : (
                  breakdowns.byDepartment.map((dept) => (
                    <div key={dept.department} className="breakdown-item">
                      <div className="breakdown-item-header">
                        <span className={`breakdown-name ${dept.department === "Unassigned" ? "text-warning" : ""}`}>
                          {dept.department === "Unassigned" ? "⚠️ Unassigned" : dept.department}
                        </span>
                        <span className="breakdown-numbers">
                          <strong>{dept.count}</strong> ({dept.percentage})
                        </span>
                      </div>
                      <div className="breakdown-bar">
                        <div
                          className={`breakdown-bar-fill ${dept.department === "Unassigned" ? "fill-unassigned" : "fill-department"}`}
                          style={{ width: dept.percentage }}
                        />
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Hotspot & Clustering Summary */}
          <div className="analytics-card hotspot-summary-card" data-testid="analytics-hotspots-card">
            <div className="card-header-row">
              <div className="card-header-left">
                <h3>
                  <Flame size={18} className="icon-flame" />
                  DBSCAN Spatial Hotspot Clusters
                </h3>
                <span className="card-subtitle">
                  Cluster-level intelligence from existing spatial detection engine
                </span>
              </div>
              <span className="card-badge badge-hotspot">
                {hotspots.active} Active Cluster{hotspots.active === 1 ? "" : "s"}
              </span>
            </div>

            <div className="hotspot-metrics-row">
              <div className="hotspot-mini-stat">
                <span className="stat-label">Total Clusters</span>
                <span className="stat-value">{hotspots.total}</span>
              </div>
              <div className="hotspot-mini-stat">
                <span className="stat-label">Active / Escalating</span>
                <span className="stat-value text-flame">{hotspots.active}</span>
              </div>
              <div className="hotspot-mini-stat">
                <span className="stat-label">Clustered Defects</span>
                <span className="stat-value">{hotspots.totalDistinctDefects}</span>
              </div>
              <div className="hotspot-mini-stat">
                <span className="stat-label">Mean Severity</span>
                <span className="stat-value">
                  {hotspots.avgSeverity !== null ? `${hotspots.avgSeverity}/10` : "—"}
                </span>
              </div>
            </div>
          </div>

          {/* Audit & Policy Documentation Footer */}
          <div className="analytics-policies-footer">
            <div className="policy-note">
              <ShieldCheck size={16} className="policy-icon" />
              <span>
                <strong>Audit Integrity:</strong> MTTR strictly calculated from verified{" "}
                <code>resolvedAt</code> timestamps. Unassigned departments aggregated canonically as{" "}
                <code>Unassigned</code>. Trends zero-filled over UTC daily boundaries.
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
