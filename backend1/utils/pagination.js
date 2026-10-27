/**
 * CivicVision AI — Server-Side Pagination Utilities (Task 1.3)
 *
 * Provides robust parameter parsing, boundary validation, and standardized
 * response structuring for paginated issue list endpoints.
 */

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * Safely parses and normalizes pagination query parameters.
 *
 * @param {object} query - Express request query object (req.query)
 * @param {object} [options]
 * @param {number} [options.defaultLimit=20] - Fallback limit when unspecified or invalid
 * @param {number} [options.maxLimit=100] - Upper bound cap to prevent resource exhaustion
 * @returns {{
 *   page: number,
 *   limit: number,
 *   skip: number,
 *   isPaginated: boolean
 * }}
 */
function parsePaginationParams(query = {}, options = {}) {
  const defaultLimit = options.defaultLimit || DEFAULT_PAGE_SIZE;
  const maxLimit = options.maxLimit || MAX_PAGE_SIZE;

  // Determine if caller explicitly requested paginated format
  const isPaginated =
    query.page !== undefined ||
    query.limit !== undefined ||
    String(query.paginate).toLowerCase() === "true";

  // Parse page: strictly integer >= 1
  let page = parseInt(query.page, 10);
  if (isNaN(page) || page < 1) {
    page = 1;
  }

  // Parse limit: integer clamped to [1, maxLimit]
  let limit = parseInt(query.limit, 10);
  if (isNaN(limit) || limit < 1) {
    limit = defaultLimit;
  } else if (limit > maxLimit) {
    limit = maxLimit;
  }

  const skip = (page - 1) * limit;

  return {
    page,
    limit,
    skip,
    isPaginated
  };
}

/**
 * Constructs a standardized pagination response payload.
 *
 * @param {Array} items - Sliced result array
 * @param {number} total - Total count matching query filters
 * @param {number} page - Current page number
 * @param {number} limit - Items per page
 * @returns {object} Formatted response object containing items and pagination metadata
 */
function buildPaginationResponse(items = [], total = 0, page = 1, limit = DEFAULT_PAGE_SIZE) {
  const safeTotal = typeof total === "number" && !isNaN(total) && total >= 0 ? total : 0;
  const safeLimit = typeof limit === "number" && limit >= 1 ? limit : DEFAULT_PAGE_SIZE;
  const totalPages = Math.ceil(safeTotal / safeLimit) || 1;
  const safePage = typeof page === "number" && page >= 1 ? page : 1;

  return {
    issues: items,
    total: safeTotal,
    page: safePage,
    limit: safeLimit,
    totalPages,
    pagination: {
      total: safeTotal,
      page: safePage,
      limit: safeLimit,
      totalPages,
      hasPrevPage: safePage > 1,
      hasNextPage: safePage < totalPages
    }
  };
}

/**
 * Attaches standard pagination headers to an Express response object.
 *
 * @param {object} res - Express response object
 * @param {number} total - Total records count
 * @param {number} page - Current page number
 * @param {number} limit - Current limit
 * @param {number} totalPages - Total calculated pages
 */
function setPaginationHeaders(res, total = 0, page = 1, limit = DEFAULT_PAGE_SIZE, totalPages = 1) {
  if (!res || typeof res.set !== "function") return;
  res.set("X-Total-Count", String(total));
  res.set("X-Total-Pages", String(totalPages));
  res.set("X-Current-Page", String(page));
  res.set("X-Page-Limit", String(limit));
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  parsePaginationParams,
  buildPaginationResponse,
  setPaginationHeaders
};
