/**
 * CivicVision AI — Performance Analytics Service (Sprint Block 2)
 *
 * Implements database-backed calculations using MongoDB aggregation pipelines
 * for the administrative portal. Strictly avoids loading entire collections into memory.
 *
 * Metric Definitions & Policy Specifications:
 * 1. Total Issues:
 *    - Count of all civic defect issues in collection.
 * 2. Open Issues:
 *    - Defined as issues active in the triage and remediation pipeline (status in ['reported', 'in-progress']).
 *    - Denominator: None (cardinal count).
 * 3. Resolved Issues:
 *    - Issues with status === 'resolved'.
 * 4. Resolution Rate:
 *    - Formula: resolvedIssues / totalIssues.
 *    - Safe handling: Returns 0.0 (0.0%) when totalIssues === 0 to prevent division by zero.
 * 5. Mean Time to Resolution (MTTR):
 *    - Calculated exclusively for resolved issues having verified, finite resolvedAt and createdAt timestamps
 *      where resolvedAt >= createdAt.
 *    - Excludes legacy records without resolvedAt and unresolved issues. Does not fabricate historical timestamps.
 *    - Denominator: Count of resolved issues with valid timestamps.
 *    - Safe handling: Returns null (formatted 'N/A') when sample size is zero.
 * 6. Issue Counts by Status:
 *    - Aggregated by status ('reported', 'in-progress', 'resolved').
 * 7. Issue Counts by Category:
 *    - Aggregated by defect type, defaulting missing/null to 'other'.
 * 8. Issue Counts by Department:
 *    - Unassigned Policy: Issues where department is null, empty, or undefined are canonically
 *      aggregated as 'Unassigned'.
 * 9. Hotspot Summary:
 *    - Database-backed aggregation on Hotspot collection for active defect clusters, severity, and report counts.
 *    - Gracefully returns empty zeros when collection is empty.
 * 10. Time-based Issue Trend:
 *     - Aggregated by daily UTC boundaries (%Y-%m-%d).
 *     - Zero-fills missing dates within the requested window to provide continuous time-series data for charts.
 */

const Issue = require("../models/Issue");
const Hotspot = require("../models/Hotspot");

const DEFAULT_TREND_DAYS = 30;
const MAX_TREND_DAYS = 90;
const MIN_TREND_DAYS = 1;

/**
 * Generates an array of continuous 'YYYY-MM-DD' date strings in UTC
 * from startDate to endDate (inclusive).
 */
function generateUtcDateRange(startDate, endDate) {
  const dates = [];
  const current = new Date(Date.UTC(
    startDate.getUTCFullYear(),
    startDate.getUTCMonth(),
    startDate.getUTCDate()
  ));
  const end = new Date(Date.UTC(
    endDate.getUTCFullYear(),
    endDate.getUTCMonth(),
    endDate.getUTCDate()
  ));

  while (current <= end) {
    const yyyy = current.getUTCFullYear();
    const mm = String(current.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(current.getUTCDate()).padStart(2, "0");
    dates.push(`${yyyy}-${mm}-${dd}`);
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

/**
 * Formats a duration in milliseconds into a concise human-readable string.
 */
function formatDuration(ms) {
  if (ms === null || ms === undefined || isNaN(ms)) {
    return "N/A";
  }
  const hours = ms / (1000 * 60 * 60);
  if (hours < 1) {
    const mins = Math.max(1, Math.round(ms / (1000 * 60)));
    return `${mins}m`;
  }
  if (hours < 48) {
    return `${hours.toFixed(1)} hrs`;
  }
  const days = hours / 24;
  return `${days.toFixed(1)} days`;
}

/**
 * Calculates comprehensive dashboard analytics via MongoDB aggregation pipelines.
 *
 * @param {Object} options
 * @param {number} [options.days=30] - Number of days to include in the daily trend (1 to 90)
 * @returns {Promise<Object>} Aggregated analytics data payload
 */
async function getDashboardAnalytics(options = {}) {
  const requestedDays = parseInt(options.days, 10);
  const trendDays = Number.isInteger(requestedDays)
    ? Math.min(MAX_TREND_DAYS, Math.max(MIN_TREND_DAYS, requestedDays))
    : DEFAULT_TREND_DAYS;

  // Establish UTC date boundaries for the trend query
  const now = new Date();
  const endDateUTC = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    23, 59, 59, 999
  ));

  const startDateUTC = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - (trendDays - 1),
    0, 0, 0, 0
  ));

  // Multi-facet MongoDB aggregation pipeline on Issue collection
  const [issueAggResult] = await Issue.aggregate([
    {
      $facet: {
        // Facet 1: Summary totals and status counts
        overview: [
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              reported: {
                $sum: { $cond: [{ $eq: ["$status", "reported"] }, 1, 0] }
              },
              inProgress: {
                $sum: { $cond: [{ $eq: ["$status", "in-progress"] }, 1, 0] }
              },
              resolved: {
                $sum: { $cond: [{ $eq: ["$status", "resolved"] }, 1, 0] }
              },
              needsReview: {
                $sum: { $cond: [{ $eq: ["$needsReview", true] }, 1, 0] }
              }
            }
          }
        ],

        // Facet 2: Mean Time to Resolution (MTTR)
        // Strictly includes only resolved issues with verified resolvedAt and createdAt
        mttr: [
          {
            $match: {
              status: "resolved",
              resolvedAt: { $exists: true, $ne: null },
              createdAt: { $exists: true, $ne: null }
            }
          },
          {
            $project: {
              diffMs: { $subtract: ["$resolvedAt", "$createdAt"] }
            }
          },
          {
            $match: {
              diffMs: { $gte: 0 } // Exclude corrupted timestamps where resolvedAt < createdAt
            }
          },
          {
            $group: {
              _id: null,
              sampleSize: { $sum: 1 },
              totalDurationMs: { $sum: "$diffMs" },
              avgDurationMs: { $avg: "$diffMs" }
            }
          }
        ],

        // Facet 3: Counts by Status
        byStatus: [
          {
            $group: {
              _id: { $ifNull: ["$status", "unknown"] },
              count: { $sum: 1 }
            }
          },
          { $sort: { count: -1 } }
        ],

        // Facet 4: Counts by Category (Defect Type)
        byCategory: [
          {
            $group: {
              _id: { $ifNull: ["$type", "other"] },
              count: { $sum: 1 }
            }
          },
          { $sort: { count: -1 } }
        ],

        // Facet 5: Counts by Department with Unassigned treatment
        byDepartment: [
          {
            $group: {
              _id: {
                $cond: [
                  {
                    $or: [
                      { $eq: ["$department", null] },
                      { $eq: ["$department", ""] },
                      { $not: ["$department"] }
                    ]
                  },
                  "Unassigned",
                  "$department"
                ]
              },
              count: { $sum: 1 }
            }
          },
          { $sort: { count: -1 } }
        ],

        // Facet 6: Daily Created Issues Trend
        trendCreated: [
          {
            $match: {
              createdAt: { $gte: startDateUTC, $lte: endDateUTC }
            }
          },
          {
            $group: {
              _id: {
                $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "UTC" }
              },
              created: { $sum: 1 }
            }
          }
        ],

        // Facet 7: Daily Resolved Issues Trend
        trendResolved: [
          {
            $match: {
              status: "resolved",
              resolvedAt: { $gte: startDateUTC, $lte: endDateUTC }
            }
          },
          {
            $group: {
              _id: {
                $dateToString: { format: "%Y-%m-%d", date: "$resolvedAt", timezone: "UTC" }
              },
              resolved: { $sum: 1 }
            }
          }
        ]
      }
    }
  ]);

  // Safely unpack aggregation results with empty defaults
  const overview = (issueAggResult?.overview && issueAggResult.overview[0]) || {
    total: 0,
    reported: 0,
    inProgress: 0,
    resolved: 0,
    needsReview: 0
  };

  const totalIssues = overview.total || 0;
  const reportedIssues = overview.reported || 0;
  const inProgressIssues = overview.inProgress || 0;
  const resolvedIssues = overview.resolved || 0;
  const needsReviewIssues = overview.needsReview || 0;

  // Open issues = non-resolved issues currently active in municipal pipeline
  const openIssues = reportedIssues + inProgressIssues;

  // Resolution Rate: safe handling when totalIssues is zero
  const resolutionRateRatio = totalIssues > 0
    ? Number((resolvedIssues / totalIssues).toFixed(4))
    : 0.0;
  const resolutionRateFormatted = `${(resolutionRateRatio * 100).toFixed(1)}%`;

  // MTTR calculations
  const mttrRecord = issueAggResult?.mttr && issueAggResult.mttr[0];
  let mttrPayload;
  if (mttrRecord && mttrRecord.sampleSize > 0) {
    const avgMs = Math.round(mttrRecord.avgDurationMs);
    const avgHours = Number((avgMs / (1000 * 60 * 60)).toFixed(2));
    const avgDays = Number((avgHours / 24).toFixed(2));
    mttrPayload = {
      avgMs,
      avgHours,
      avgDays,
      sampleSize: mttrRecord.sampleSize,
      formatted: formatDuration(avgMs),
      definition: "Mean Time to Resolution (MTTR) calculated exclusively from resolved issues with verified resolvedAt and createdAt timestamps where resolvedAt >= createdAt."
    };
  } else {
    mttrPayload = {
      avgMs: null,
      avgHours: null,
      avgDays: null,
      sampleSize: 0,
      formatted: "N/A (No resolved issues with timestamps)",
      definition: "Mean Time to Resolution (MTTR) calculated exclusively from resolved issues with verified resolvedAt and createdAt timestamps where resolvedAt >= createdAt."
    };
  }

  // Format Breakdowns
  const byStatusMap = {
    reported: 0,
    "in-progress": 0,
    resolved: 0
  };
  (issueAggResult?.byStatus || []).forEach((item) => {
    if (item._id) byStatusMap[item._id] = item.count;
  });

  const byCategory = (issueAggResult?.byCategory || []).map((item) => ({
    category: item._id,
    count: item.count,
    percentage: totalIssues > 0
      ? `${((item.count / totalIssues) * 100).toFixed(1)}%`
      : "0.0%"
  }));

  const byDepartment = (issueAggResult?.byDepartment || []).map((item) => ({
    department: item._id,
    count: item.count,
    percentage: totalIssues > 0
      ? `${((item.count / totalIssues) * 100).toFixed(1)}%`
      : "0.0%"
  }));

  // Build continuous daily trend series (zero-filled)
  const createdMap = new Map();
  (issueAggResult?.trendCreated || []).forEach((row) => {
    if (row._id) createdMap.set(row._id, row.created);
  });

  const resolvedMap = new Map();
  (issueAggResult?.trendResolved || []).forEach((row) => {
    if (row._id) resolvedMap.set(row._id, row.resolved);
  });

  const dateRange = generateUtcDateRange(startDateUTC, endDateUTC);
  const trendSeries = dateRange.map((dateStr) => {
    const created = createdMap.get(dateStr) || 0;
    const resolved = resolvedMap.get(dateStr) || 0;
    return {
      date: dateStr,
      created,
      resolved,
      netChange: created - resolved
    };
  });

  // Query Hotspot summary safely using existing Hotspot model
  let hotspotSummary = {
    total: 0,
    active: 0,
    resolving: 0,
    resolved: 0,
    dismissed: 0,
    totalDistinctDefects: 0,
    totalCitizenReports: 0,
    avgSeverity: null,
    byCategory: []
  };

  try {
    const [hotspotAggResult] = await Hotspot.aggregate([
      {
        $facet: {
          overview: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                active: {
                  $sum: {
                    $cond: [{ $in: ["$status", ["active", "escalating"]] }, 1, 0]
                  }
                },
                resolving: {
                  $sum: { $cond: [{ $eq: ["$status", "resolving"] }, 1, 0] }
                },
                resolved: {
                  $sum: { $cond: [{ $eq: ["$status", "resolved"] }, 1, 0] }
                },
                dismissed: {
                  $sum: { $cond: [{ $eq: ["$status", "dismissed"] }, 1, 0] }
                },
                totalDistinctDefects: { $sum: "$distinctDefectCount" },
                totalCitizenReports: { $sum: "$totalReportCount" },
                avgSeverity: { $avg: "$meanSeverity" }
              }
            }
          ],
          byCategory: [
            {
              $group: {
                _id: "$category",
                count: { $sum: 1 },
                activeCount: {
                  $sum: {
                    $cond: [{ $in: ["$status", ["active", "escalating"]] }, 1, 0]
                  }
                }
              }
            },
            { $sort: { count: -1 } }
          ]
        }
      }
    ]);

    if (hotspotAggResult?.overview && hotspotAggResult.overview[0]) {
      const hOv = hotspotAggResult.overview[0];
      hotspotSummary = {
        total: hOv.total || 0,
        active: hOv.active || 0,
        resolving: hOv.resolving || 0,
        resolved: hOv.resolved || 0,
        dismissed: hOv.dismissed || 0,
        totalDistinctDefects: hOv.totalDistinctDefects || 0,
        totalCitizenReports: hOv.totalCitizenReports || 0,
        avgSeverity: hOv.avgSeverity !== null && !isNaN(hOv.avgSeverity)
          ? Number(hOv.avgSeverity.toFixed(2))
          : null,
        byCategory: (hotspotAggResult.byCategory || []).map((cat) => ({
          category: cat._id,
          count: cat.count,
          activeCount: cat.activeCount
        }))
      };
    }
  } catch (hotspotErr) {
    // If Hotspot query fails (e.g. unindexed or unavailable), return default zeros gracefully
    hotspotSummary.error = hotspotErr.message;
  }

  return {
    summary: {
      totalIssues,
      openIssues,
      resolvedIssues,
      reportedIssues,
      inProgressIssues,
      needsReviewIssues,
      resolutionRate: resolutionRateRatio,
      resolutionRateFormatted
    },
    mttr: mttrPayload,
    breakdowns: {
      byStatus: byStatusMap,
      byCategory,
      byDepartment
    },
    hotspots: hotspotSummary,
    trend: {
      interval: "daily",
      timezone: "UTC",
      days: trendDays,
      startDate: startDateUTC.toISOString(),
      endDate: endDateUTC.toISOString(),
      data: trendSeries
    },
    metadata: {
      generatedAt: new Date().toISOString(),
      policies: {
        openIssuesDefinition: "Issues with status 'reported' or 'in-progress' (active in triage and remediation pipeline).",
        resolutionRateDenominator: "Total issues in collection (resolvedIssues / totalIssues).",
        mttrDenominator: "Resolved issues with verified resolvedAt and createdAt timestamps (resolvedAt >= createdAt).",
        unassignedDepartmentPolicy: "Issues where department is null, empty string, or undefined are aggregated under 'Unassigned'.",
        trendTimezone: "UTC canonical daily date boundaries (%Y-%m-%d)."
      }
    }
  };
}

module.exports = {
  getDashboardAnalytics,
  generateUtcDateRange,
  formatDuration
};
