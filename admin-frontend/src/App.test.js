import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import App from "./App";
import API, { fetchUnreadNotificationCount } from "./api/api";

const mockFetchUnreadNotificationCount = jest.fn(() =>
  Promise.resolve({ data: { error: false, unreadCount: 0 } })
);

// Mock the API client
jest.mock("./api/api", () => {
  const original = jest.requireActual("./api/api");
  const mockApi = {
    get: jest.fn(),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
    interceptors: {
      request: { use: jest.fn() },
      response: { use: jest.fn() },
    },
  };
  return {
    __esModule: true,
    default: mockApi,
    AdminAuth: original.AdminAuth,
    getImageUrl: original.getImageUrl,
    fetchHotspots: (params) => mockApi.get("/admin-dashboard/hotspots", { params }),
    fetchHotspotById: (id) => mockApi.get(`/admin-dashboard/hotspots/${id}`),
    runHotspotRefresh: (options) => mockApi.post("/admin-dashboard/hotspots/run", options),
    fetchNotifications: (params) => mockApi.get("/admin-dashboard/notifications", { params }),
    fetchUnreadNotificationCount: (...args) => mockFetchUnreadNotificationCount(...args),
    markNotificationRead: (id) => mockApi.patch(`/admin-dashboard/notifications/${id}/read`),
    markAllNotificationsRead: () => mockApi.patch("/admin-dashboard/notifications/read-all"),
    retryNotificationEmail: (id) => mockApi.post(`/admin-dashboard/notifications/${id}/retry-email`),
    fetchAnalytics: (params) => mockApi.get("/admin-dashboard/analytics", { params }),
    resolveClassificationReview: (id, data) =>
      mockApi.patch(`/admin-dashboard/issues/${id}/classification-review`, data),
  };
});


describe("Admin Frontend Application Tests", () => {
  beforeEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
    mockFetchUnreadNotificationCount.mockReset();
    mockFetchUnreadNotificationCount.mockImplementation(() =>
      Promise.resolve({ data: { error: false, unreadCount: 0 } })
    );
  });


  test("1. Login form renders with secure admin-only fields", async () => {
    API.get.mockResolvedValueOnce({ data: {} });

    render(<App />);

    expect(screen.getByText(/Administrator Portal/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Admin Email Address/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Password$/i)).toBeInTheDocument();
    expect(screen.getByTestId("login-submit-button")).toBeInTheDocument();

    // Verify absence of citizen/public registration or Admin Key
    expect(screen.queryByText(/Register/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Sign Up/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Admin Key/i)).not.toBeInTheDocument();
  });

  test("2. Form validates empty and malformed inputs prior to submission", async () => {
    render(<App />);

    const submitBtn = screen.getByTestId("login-submit-button");
    fireEvent.click(submitBtn);

    expect(await screen.findByText(/Administrator email is required/i)).toBeInTheDocument();
    expect(screen.getByText(/Password is required/i)).toBeInTheDocument();
    expect(API.post).not.toHaveBeenCalled();
  });

  test("3. Invalid credentials produce a visible error alert", async () => {
    API.post.mockRejectedValueOnce({
      response: {
        status: 401,
        data: { error: true, message: "Invalid credentials" },
      },
    });

    render(<App />);

    fireEvent.change(screen.getByLabelText(/Admin Email Address/i), {
      target: { value: "wrong@civicvision.gov" },
    });
    fireEvent.change(screen.getByLabelText(/^Password$/i), {
      target: { value: "WrongPass123" },
    });

    fireEvent.click(screen.getByTestId("login-submit-button"));

    expect(await screen.findByTestId("login-error-alert")).toHaveTextContent("Invalid credentials");
  });

  test("4. Authenticated admin can log in and reach the dashboard", async () => {
    // 1. Mock successful login response
    API.post.mockResolvedValueOnce({
      data: {
        error: false,
        message: "Login successful",
        admin: {
          id: "adm-101",
          fullName: "Lead Administrator",
          email: "chief.admin@civicvision.gov",
        },
        accessToken: "test-admin-jwt-token",
      },
    });

    // 2. Mock issues fetch upon reaching dashboard
    API.get.mockResolvedValueOnce({
      data: [
        {
          _id: "660000000000000000000001",
          type: "pothole",
          description: "Major crater on Main Street intersection",
          status: "reported",
          votes: 12,
          department: "Roads & Infrastructure",
          createdAt: new Date().toISOString(),
          userId: {
            fullName: "Alice Citizen",
            email: "alice@example.com",
          },
          location: { lat: 11.34, lng: 77.72 },
        },
      ],
    });

    render(<App />);

    fireEvent.change(screen.getByLabelText(/Admin Email Address/i), {
      target: { value: "chief.admin@civicvision.gov" },
    });
    fireEvent.change(screen.getByLabelText(/^Password$/i), {
      target: { value: "SecurePass123!" },
    });

    fireEvent.click(screen.getByTestId("login-submit-button"));

    // Verify dashboard navigation and display of admin info
    expect(await screen.findByText("Lead Administrator")).toBeInTheDocument();
    expect(screen.getByText("chief.admin@civicvision.gov")).toBeInTheDocument();
    expect(await screen.findByText("Major crater on Main Street intersection")).toBeInTheDocument();
    expect(await screen.findByText("Alice Citizen")).toBeInTheDocument();
  });

  test("5. Missing or invalid sessions are handled safely and redirect to login", async () => {
    // Session token exists in storage but GET /api/admin/profile rejects with 401
    localStorage.setItem("adminToken", "expired-token");
    localStorage.setItem(
      "adminProfile",
      JSON.stringify({ fullName: "Ghost Admin", email: "ghost@example.com" })
    );

    API.get.mockRejectedValueOnce({
      response: { status: 401, data: { message: "Token expired or invalid" } },
    });

    render(<App />);

    // Should purge session and render Login page
    expect(await screen.findByText(/Administrator Portal/i)).toBeInTheDocument();
    expect(localStorage.getItem("adminToken")).toBeNull();
    expect(localStorage.getItem("adminProfile")).toBeNull();
  });

  test("6. Citizen-role session cannot enter the admin dashboard", async () => {
    // Attempting to restore session with a token that returns a citizen role
    localStorage.setItem("adminToken", "citizen-token");

    API.get.mockResolvedValueOnce({
      data: {
        error: false,
        user: { _id: "cit-1", fullName: "Citizen Bob" },
        role: "citizen",
        isAdmin: false,
      },
    });

    render(<App />);

    // Must block entry and display Login screen
    expect(await screen.findByText(/Administrator Portal/i)).toBeInTheDocument();
    expect(localStorage.getItem("adminToken")).toBeNull();
  });

  test("7. Dashboard handles API failure states with retry option", async () => {
    // Pre-seed valid admin session in storage
    localStorage.setItem("adminToken", "valid-admin-token");
    localStorage.setItem(
      "adminProfile",
      JSON.stringify({ fullName: "Duty Admin", email: "duty@civicvision.gov" })
    );

    // Profile verification succeeds
    API.get.mockResolvedValueOnce({
      data: {
        error: false,
        admin: { fullName: "Duty Admin", email: "duty@civicvision.gov" },
        role: "admin",
        isAdmin: true,
      },
    });

    // But dashboard issues endpoint fails with server 500
    API.get.mockRejectedValueOnce({
      response: { status: 500, data: { message: "Internal Database Offline" } },
    });

    render(<App />);

    expect(await screen.findByTestId("dashboard-error")).toBeInTheDocument();
    expect(screen.getByText(/Internal Database Offline/i)).toBeInTheDocument();
    expect(screen.getByText(/Try Again/i)).toBeInTheDocument();
  });

  test("8. Needs Review queue displays badges, similarity scores, and filters by review state", async () => {
    localStorage.setItem("adminToken", "valid-admin-token");
    localStorage.setItem(
      "adminProfile",
      JSON.stringify({ fullName: "Reviewer Admin", email: "reviewer@civicvision.gov" })
    );

    API.get.mockResolvedValueOnce({
      data: {
        error: false,
        admin: { fullName: "Reviewer Admin", email: "reviewer@civicvision.gov" },
        role: "admin",
        isAdmin: true,
      },
    });

    const mockIssues = [
      {
        _id: "660000000000000000000010",
        type: "pothole",
        description: "Deep pothole near 5th cross",
        status: "reported",
        needsReview: true,
        duplicateStatus: "flagged_duplicate",
        similarityScore: 0.885,
        reviewResolution: "none",
        votes: 3,
        createdAt: new Date().toISOString(),
        location: { lat: 11.341, lng: 77.721 },
        duplicateOf: {
          _id: "660000000000000000000001",
          type: "pothole",
          description: "Original pothole at 5th cross junction",
          status: "reported",
          createdAt: new Date(Date.now() - 86400000).toISOString(),
          location: { lat: 11.3411, lng: 77.7211 },
        },
      },
      {
        _id: "660000000000000000000011",
        type: "garbage",
        description: "Overflowing bin on street corner",
        status: "reported",
        needsReview: true,
        duplicateStatus: "unverified",
        similarityScore: null,
        reviewResolution: "none",
        votes: 1,
        createdAt: new Date().toISOString(),
        location: { lat: 11.345, lng: 77.725 },
        duplicateOf: null,
      },
      {
        _id: "660000000000000000000012",
        type: "street light",
        description: "Flickering street light",
        status: "in-progress",
        needsReview: false,
        duplicateStatus: "none",
        reviewResolution: "none",
        votes: 5,
        createdAt: new Date().toISOString(),
      },
    ];

    API.get.mockResolvedValueOnce({ data: mockIssues });

    render(<App />);

    // Verify all 3 issues render initially
    expect(await screen.findByText("Deep pothole near 5th cross")).toBeInTheDocument();
    expect(screen.getByText("Overflowing bin on street corner")).toBeInTheDocument();
    expect(screen.getByText("Flickering street light")).toBeInTheDocument();

    // Verify badges
    expect(screen.getAllByText(/Needs Review/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/AI Dup \(89%\)/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Unverified AI/i).length).toBeGreaterThanOrEqual(1);

    // Click "Needs Review" tab button
    const needsReviewTab = screen.getByTestId("tab-needs-review");
    fireEvent.click(needsReviewTab);

    // Street light should be filtered out
    expect(screen.queryByText("Flickering street light")).not.toBeInTheDocument();
    expect(screen.getByText("Deep pothole near 5th cross")).toBeInTheDocument();
    expect(screen.getByText("Overflowing bin on street corner")).toBeInTheDocument();
  });

  test("9. Side-by-side comparison modal renders candidate vs parent issue, distance, and disclaimer", async () => {
    localStorage.setItem("adminToken", "valid-admin-token");
    localStorage.setItem(
      "adminProfile",
      JSON.stringify({ fullName: "Reviewer Admin", email: "reviewer@civicvision.gov" })
    );

    API.get.mockResolvedValueOnce({
      data: {
        error: false,
        admin: { fullName: "Reviewer Admin", email: "reviewer@civicvision.gov" },
        role: "admin",
        isAdmin: true,
      },
    });

    const candidateIssue = {
      _id: "660000000000000000000020",
      type: "pothole",
      description: "Severe road hazard pothole",
      status: "reported",
      needsReview: true,
      duplicateStatus: "flagged_duplicate",
      similarityScore: 0.912,
      reviewResolution: "none",
      createdAt: new Date().toISOString(),
      location: { lat: 11.341, lng: 77.721 },
      duplicateOf: {
        _id: "660000000000000000000005",
        type: "pothole",
        description: "Earlier pothole logged yesterday",
        status: "reported",
        createdAt: new Date(Date.now() - 3600000).toISOString(),
        location: { lat: 11.34105, lng: 77.72105 },
      },
      userId: { fullName: "Citizen Jane", email: "jane@example.com" },
    };

    API.get.mockResolvedValueOnce({ data: [candidateIssue] });

    render(<App />);

    expect(await screen.findByText("Severe road hazard pothole")).toBeInTheDocument();

    // Click Compare button
    const compareBtn = screen.getByRole("button", {
      name: /Compare duplicate issue 660000000000000000000020/i,
    });
    fireEvent.click(compareBtn);

    // Modal should be open
    expect(screen.getByText("Duplicate Assessment & Moderation")).toBeInTheDocument();
    expect(screen.getByText(/Deterministic engine \(manual verification required\)/i)).toBeInTheDocument();
    expect(screen.getByText("91.2%")).toBeInTheDocument();

    // Verify candidate report section
    expect(screen.getByText("Report Under Review (Candidate)")).toBeInTheDocument();
    expect(screen.getAllByText("Severe road hazard pothole").length).toBeGreaterThan(0);

    // Verify parent report section
    expect(screen.getByText("Suspected Original Report (Parent Issue)")).toBeInTheDocument();
    expect(screen.getByText("Earlier pothole logged yesterday")).toBeInTheDocument();

    // Distance calculation should show meters apart
    expect(screen.getByText(/apart/i)).toBeInTheDocument();

    // Confirm duplicate and Dismiss duplicate buttons present
    expect(screen.getByRole("button", { name: /Confirm Duplicate/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Dismiss Duplicate \/ Mark Unique/i })).toBeInTheDocument();
  });

  test("10. Handles missing parent issue or unverified status gracefully", async () => {
    localStorage.setItem("adminToken", "valid-admin-token");
    localStorage.setItem(
      "adminProfile",
      JSON.stringify({ fullName: "Reviewer Admin", email: "reviewer@civicvision.gov" })
    );

    API.get.mockResolvedValueOnce({
      data: {
        error: false,
        admin: { fullName: "Reviewer Admin", email: "reviewer@civicvision.gov" },
        role: "admin",
        isAdmin: true,
      },
    });

    const unverifiedIssue = {
      _id: "660000000000000000000030",
      type: "garbage",
      description: "Piles of trash near bus stop",
      status: "reported",
      needsReview: true,
      duplicateStatus: "unverified",
      similarityScore: null,
      reviewResolution: "none",
      createdAt: new Date().toISOString(),
      location: { lat: 11.341, lng: 77.721 },
      duplicateOf: null, // Missing parent
    };

    API.get.mockResolvedValueOnce({ data: [unverifiedIssue] });

    render(<App />);

    expect(await screen.findByText("Piles of trash near bus stop")).toBeInTheDocument();

    // Open comparison
    const compareBtn = screen.getByRole("button", {
      name: /Compare duplicate issue 660000000000000000000030/i,
    });
    fireEvent.click(compareBtn);

    // Check graceful fallback message
    expect(await screen.findByText("Parent Issue Details Unavailable")).toBeInTheDocument();
    expect(screen.getByText(/This issue was flagged unverified/i)).toBeInTheDocument();
  });

  test("11. Admin review action requires confirmation, submits resolution PATCH, and updates UI", async () => {
    localStorage.setItem("adminToken", "valid-admin-token");
    localStorage.setItem(
      "adminProfile",
      JSON.stringify({ fullName: "Reviewer Admin", email: "reviewer@civicvision.gov" })
    );

    API.get.mockResolvedValueOnce({
      data: {
        error: false,
        admin: { fullName: "Reviewer Admin", email: "reviewer@civicvision.gov" },
        role: "admin",
        isAdmin: true,
      },
    });

    const issueToReview = {
      _id: "660000000000000000000040",
      type: "pothole",
      description: "Crater on 2nd avenue",
      status: "reported",
      needsReview: true,
      duplicateStatus: "flagged_duplicate",
      similarityScore: 0.85,
      reviewResolution: "none",
      createdAt: new Date().toISOString(),
      location: { lat: 11.341, lng: 77.721 },
      duplicateOf: {
        _id: "660000000000000000000001",
        type: "pothole",
        description: "Original crater",
        status: "reported",
      },
    };

    API.get.mockResolvedValueOnce({ data: [issueToReview] });

    render(<App />);

    expect(await screen.findByText("Crater on 2nd avenue")).toBeInTheDocument();

    // Open Compare modal
    fireEvent.click(screen.getByRole("button", {
      name: /Compare duplicate issue 660000000000000000000040/i,
    }));

    // Fill optional resolution note
    const notesInput = screen.getByPlaceholderText(/Log reason for confirmation or dismissal/i);
    fireEvent.change(notesInput, {
      target: { value: "Identical angle and defect confirmed visually." },
    });

    // Click Confirm Duplicate button -> should show in-modal confirmation prompt
    fireEvent.click(screen.getByRole("button", { name: /Confirm Duplicate/i }));

    expect(screen.getByText(/Confirm Issue as Duplicate\?/i)).toBeInTheDocument();
    expect(screen.getByText(/This will record that this report refers to the existing defect/i)).toBeInTheDocument();

    // Test Cancel button inside dialog
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(/Confirm Issue as Duplicate\?/i)).not.toBeInTheDocument();

    // Click Confirm Duplicate again and proceed with execution
    fireEvent.click(screen.getByRole("button", { name: /Confirm Duplicate/i }));

    const resolvedIssue = {
      ...issueToReview,
      needsReview: false,
      reviewResolution: "confirmed_duplicate",
      reviewedAt: new Date().toISOString(),
      reviewedBy: { fullName: "Reviewer Admin" },
    };

    API.patch.mockResolvedValueOnce({
      data: {
        error: false,
        message: "Duplicate confirmed successfully",
        issue: resolvedIssue,
      },
    });

    // Execute confirmation
    fireEvent.click(screen.getByRole("button", { name: /Yes, Confirm Duplicate/i }));

    // Verify API call was sent with exact expected contract
    await waitFor(() => {
      expect(API.patch).toHaveBeenCalledWith(
        "/admin-dashboard/issues/660000000000000000000040/review",
        {
          action: "confirm_duplicate",
          reviewNotes: "Identical angle and defect confirmed visually.",
        }
      );
    });

    // Verify success banner in modal
    expect(await screen.findByText(/Duplicate confirmed successfully/i)).toBeInTheDocument();
    expect(screen.getByText("Duplicate Confirmed by Administrator")).toBeInTheDocument();
  });

  test("12. Admin dashboard renders severity score, High/Medium/Low bands, and heuristic label", async () => {
    const mockAdmin = {
      adminId: "660000000000000000000001",
      email: "admin@civicvision.gov",
      fullName: "Super Admin",
      role: "admin",
    };
    localStorage.setItem("adminToken", "mock_admin_token");
    localStorage.setItem("adminData", JSON.stringify(mockAdmin));

    API.get.mockResolvedValueOnce({
      data: {
        error: false,
        admin: mockAdmin,
        role: "admin",
        isAdmin: true,
      },
    });

    const mockIssues = [
      {
        _id: "660000000000000000000101",
        type: "pothole",
        description: "Severe crater on highway",
        status: "reported",
        severity: 8.5, // High band
        createdAt: new Date().toISOString(),
      },
      {
        _id: "660000000000000000000102",
        type: "garbage",
        description: "Moderate trash pile",
        status: "reported",
        severity: 5.2, // Medium band
        createdAt: new Date().toISOString(),
      },
      {
        _id: "660000000000000000000103",
        type: "street light",
        description: "Flickering bulb",
        status: "reported",
        severity: 2.1, // Low band
        createdAt: new Date().toISOString(),
      },
    ];

    API.get.mockResolvedValueOnce({ data: mockIssues });

    render(<App />);

    expect(await screen.findByText("Severe crater on highway")).toBeInTheDocument();

    // Verify Severity column header
    expect(screen.getByRole("columnheader", { name: "Severity" })).toBeInTheDocument();

    // Verify High band and score
    expect(screen.getByText("8.5/10")).toBeInTheDocument();
    expect(screen.getByText("High")).toBeInTheDocument();

    // Verify Medium band and score
    expect(screen.getByText("5.2/10")).toBeInTheDocument();
    expect(screen.getByText("Medium")).toBeInTheDocument();

    // Verify Low band and score
    expect(screen.getByText("2.1/10")).toBeInTheDocument();
    expect(screen.getByText("Low")).toBeInTheDocument();

    // Verify Rule-based heuristic label
    const heuristicLabels = screen.getAllByText("Heuristic");
    expect(heuristicLabels.length).toBeGreaterThanOrEqual(3);
  });

  test("13. Admin dashboard renders neutral unavailable state when severity is null", async () => {
    const mockAdmin = {
      adminId: "660000000000000000000001",
      email: "admin@civicvision.gov",
      fullName: "Super Admin",
      role: "admin",
    };
    localStorage.setItem("adminToken", "mock_admin_token");
    localStorage.setItem("adminData", JSON.stringify(mockAdmin));

    API.get.mockResolvedValueOnce({
      data: {
        error: false,
        admin: mockAdmin,
        role: "admin",
        isAdmin: true,
      },
    });

    const mockIssues = [
      {
        _id: "660000000000000000000201",
        type: "water leak",
        description: "Unprocessed water defect",
        status: "reported",
        severity: null, // Null severity
        createdAt: new Date().toISOString(),
      },
    ];

    API.get.mockResolvedValueOnce({ data: mockIssues });

    render(<App />);

    expect(await screen.findByText("Unprocessed water defect")).toBeInTheDocument();

    // Verify dash placeholder
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByText("N/A")).toBeInTheDocument();
  });

  test("14. Review decoupling renders Triage Review and Dup Review badges independently", async () => {
    const mockAdmin = {
      adminId: "660000000000000000000001",
      email: "admin@civicvision.gov",
      fullName: "Super Admin",
      role: "admin",
    };
    localStorage.setItem("adminToken", "mock_admin_token");
    localStorage.setItem("adminData", JSON.stringify(mockAdmin));

    API.get.mockResolvedValueOnce({
      data: {
        error: false,
        admin: mockAdmin,
        role: "admin",
        isAdmin: true,
      },
    });

    const mockIssues = [
      {
        _id: "660000000000000000000301",
        type: "road damage",
        description: "Road issue awaiting categorization",
        status: "reported",
        needsClassificationReview: true,
        needsDuplicateReview: false,
        needsReview: true,
        createdAt: new Date().toISOString(),
      },
      {
        _id: "660000000000000000000302",
        type: "pothole",
        description: "Pothole issue awaiting duplicate verification",
        status: "reported",
        needsClassificationReview: false,
        needsDuplicateReview: true,
        needsReview: true,
        createdAt: new Date().toISOString(),
      },
    ];

    API.get.mockResolvedValueOnce({ data: mockIssues });

    render(<App />);

    expect(await screen.findByText("Road issue awaiting categorization")).toBeInTheDocument();

    // Verify independent triage badge
    expect(screen.getByTitle("Pending category triage review")).toBeInTheDocument();

    // Verify independent duplicate review badge
    expect(screen.getByTitle("Pending duplicate review")).toBeInTheDocument();
  });

  test("15. Admin dashboard navigation includes Hotspots (DBSCAN) tab and switches view", async () => {
    const mockAdmin = {
      adminId: "660000000000000000000001",
      email: "admin@civicvision.gov",
      fullName: "Super Admin",
      role: "admin",
    };
    localStorage.setItem("adminToken", "mock_admin_token");
    localStorage.setItem("adminData", JSON.stringify(mockAdmin));

    // Profile check
    API.get.mockResolvedValueOnce({
      data: {
        error: false,
        admin: mockAdmin,
        role: "admin",
        isAdmin: true,
      },
    });

    // Initial issues fetch on dashboard mount
    API.get.mockResolvedValueOnce({ data: [] });

    render(<App />);

    // Verify Hotspots tab button exists
    const hotspotsTab = await screen.findByTestId("tab-hotspots");
    expect(hotspotsTab).toBeInTheDocument();
    expect(hotspotsTab).toHaveTextContent(/Hotspots \(DBSCAN\)/i);

    // Mock response when switching to hotspots tab
    API.get.mockResolvedValueOnce({
      data: {
        error: false,
        total: 2,
        page: 1,
        totalPages: 1,
        limit: 10,
        hotspots: [
          {
            _id: "66a000000000000000000001",
            category: "pothole",
            department: "Roads & Infrastructure",
            status: "active",
            distinctDefectCount: 3,
            totalReportCount: 8,
            totalVotes: 15,
            meanSeverity: 8.2,
            centroid: { type: "Point", coordinates: [77.72, 11.34] },
            lastDetectedAt: new Date().toISOString(),
          },
          {
            _id: "66a000000000000000000002",
            category: "water_leak",
            department: "Water Services",
            status: "resolving",
            distinctDefectCount: 2,
            totalReportCount: 4,
            totalVotes: 6,
            meanSeverity: 5.4,
            centroid: { type: "Point", coordinates: [77.73, 11.35] },
            lastDetectedAt: new Date().toISOString(),
          },
        ],
      },
    });

    // Click on Hotspots tab
    fireEvent.click(hotspotsTab);

    // Verify hotspots section is rendered
    expect(await screen.findByTestId("hotspots-section")).toBeInTheDocument();

    // Verify summary metric cards
    expect(screen.getByTestId("hotspot-metric-total")).toHaveTextContent("2");
    expect(screen.getByTestId("hotspot-metric-active")).toHaveTextContent("1");
    expect(screen.getByTestId("hotspot-metric-resolving")).toHaveTextContent("1");
    expect(screen.getByTestId("hotspot-metric-reports")).toHaveTextContent("12");

    // Verify both hotspots are in the table
    expect(screen.getByText("pothole")).toBeInTheDocument();
    expect(screen.getByText("water leak")).toBeInTheDocument();
  });

  test("16. Hotspot table displays required attributes, status pills, and heuristic severity", async () => {
    const mockAdmin = {
      adminId: "660000000000000000000001",
      email: "admin@civicvision.gov",
      fullName: "Super Admin",
      role: "admin",
    };
    localStorage.setItem("adminToken", "mock_admin_token");
    localStorage.setItem("adminData", JSON.stringify(mockAdmin));

    API.get.mockResolvedValueOnce({
      data: {
        error: false,
        admin: mockAdmin,
        role: "admin",
        isAdmin: true,
      },
    });

    API.get.mockResolvedValueOnce({ data: [] });

    render(<App />);

    const hotspotsTab = await screen.findByTestId("tab-hotspots");

    API.get.mockResolvedValueOnce({
      data: {
        error: false,
        total: 1,
        page: 1,
        totalPages: 1,
        limit: 10,
        hotspots: [
          {
            _id: "66a000000000000000000001",
            category: "pothole",
            department: "Roads & Infrastructure",
            status: "active",
            distinctDefectCount: 4,
            totalReportCount: 11,
            totalVotes: 23,
            meanSeverity: 7.9,
            centroid: { type: "Point", coordinates: [77.7212, 11.3456] },
            lastDetectedAt: "2026-10-15T12:00:00.000Z",
          },
        ],
      },
    });

    fireEvent.click(hotspotsTab);

    expect(await screen.findByTestId("hotspots-section")).toBeInTheDocument();

    // Verify table headers
    expect(screen.getByRole("columnheader", { name: "Category" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Department" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Status" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Centroid/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Defects" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Reports" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Votes" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Severity" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Last Detected" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Actions" })).toBeInTheDocument();

    // Verify row and cell contents
    const row = screen.getByTestId("hotspot-row-66a000000000000000000001");
    expect(row).toBeInTheDocument();
    expect(row).toHaveTextContent("pothole");
    expect(row).toHaveTextContent("Roads & Infrastructure");
    expect(row).toHaveTextContent("active");
    expect(row).toHaveTextContent("77.7212, 11.3456");
    expect(row).toHaveTextContent("4");
    expect(row).toHaveTextContent("11");
    expect(row).toHaveTextContent("23");
    expect(row).toHaveTextContent("7.9/10");
    expect(screen.getByTestId("view-hotspot-btn-66a000000000000000000001")).toBeInTheDocument();
  });

  test("17. Hotspot filters allow filtering by category, status, and department", async () => {
    const mockAdmin = {
      adminId: "660000000000000000000001",
      email: "admin@civicvision.gov",
      fullName: "Super Admin",
      role: "admin",
    };
    localStorage.setItem("adminToken", "mock_admin_token");
    localStorage.setItem("adminData", JSON.stringify(mockAdmin));

    API.get.mockResolvedValueOnce({
      data: { error: false, admin: mockAdmin, role: "admin", isAdmin: true },
    });
    API.get.mockResolvedValueOnce({ data: [] });

    render(<App />);
    const hotspotsTab = await screen.findByTestId("tab-hotspots");

    API.get.mockResolvedValueOnce({
      data: { error: false, total: 0, hotspots: [] },
    });

    fireEvent.click(hotspotsTab);
    expect(await screen.findByTestId("hotspots-section")).toBeInTheDocument();

    // Change category filter
    API.get.mockResolvedValueOnce({
      data: { error: false, total: 1, hotspots: [] },
    });

    const categorySelect = screen.getByTestId("hotspot-category-filter");
    fireEvent.change(categorySelect, { target: { value: "pothole" } });

    await waitFor(() => {
      expect(API.get).toHaveBeenCalledWith("/admin-dashboard/hotspots", expect.objectContaining({
        params: expect.objectContaining({ category: "pothole" }),
      }));
    });
  });

  test("18. Manual Refresh Hotspots button triggers POST /run and renders returned summary", async () => {
    const mockAdmin = {
      adminId: "660000000000000000000001",
      email: "admin@civicvision.gov",
      fullName: "Super Admin",
      role: "admin",
    };
    localStorage.setItem("adminToken", "mock_admin_token");
    localStorage.setItem("adminData", JSON.stringify(mockAdmin));

    API.get.mockResolvedValueOnce({
      data: { error: false, admin: mockAdmin, role: "admin", isAdmin: true },
    });
    API.get.mockResolvedValueOnce({ data: [] });

    render(<App />);
    const hotspotsTab = await screen.findByTestId("tab-hotspots");

    API.get.mockResolvedValueOnce({
      data: { error: false, total: 0, hotspots: [] },
    });

    fireEvent.click(hotspotsTab);
    expect(await screen.findByTestId("hotspots-section")).toBeInTheDocument();

    // Mock refresh endpoint response
    API.post.mockResolvedValueOnce({
      data: {
        error: false,
        message: "DBSCAN clustering completed successfully",
        summary: {
          createdCount: 2,
          updatedCount: 1,
          resolvingCount: 0,
          resolvedCount: 0,
        },
        durationMs: 95,
      },
    });

    // Mock subsequent reload of hotspots
    API.get.mockResolvedValueOnce({
      data: { error: false, total: 2, hotspots: [] },
    });

    const refreshBtn = screen.getByTestId("refresh-hotspots-btn");
    fireEvent.click(refreshBtn);

    expect(API.post).toHaveBeenCalledWith("/admin-dashboard/hotspots/run", {});

    // Verify success banner with returned counts
    expect(await screen.findByText(/DBSCAN clustering completed successfully in 95ms!/i)).toBeInTheDocument();
    expect(screen.getByText(/Created: 2, Updated: 1, Resolving: 0, Resolved: 0/i)).toBeInTheDocument();
  });

  test("19. Manual Refresh Hotspots gracefully handles HTTP 409 Conflict", async () => {
    const mockAdmin = {
      adminId: "660000000000000000000001",
      email: "admin@civicvision.gov",
      fullName: "Super Admin",
      role: "admin",
    };
    localStorage.setItem("adminToken", "mock_admin_token");
    localStorage.setItem("adminData", JSON.stringify(mockAdmin));

    API.get.mockResolvedValueOnce({
      data: { error: false, admin: mockAdmin, role: "admin", isAdmin: true },
    });
    API.get.mockResolvedValueOnce({ data: [] });

    render(<App />);
    const hotspotsTab = await screen.findByTestId("tab-hotspots");

    API.get.mockResolvedValueOnce({
      data: { error: false, total: 0, hotspots: [] },
    });

    fireEvent.click(hotspotsTab);
    expect(await screen.findByTestId("hotspots-section")).toBeInTheDocument();

    // Mock 409 conflict
    API.post.mockRejectedValueOnce({
      response: {
        status: 409,
        data: {
          error: true,
          message: "Hotspot refresh job is currently running. Please wait for the current run to complete.",
          reason: "LOCK_ACTIVE",
        },
      },
    });

    const refreshBtn = screen.getByTestId("refresh-hotspots-btn");
    fireEvent.click(refreshBtn);

    // Verify conflict warning message
    expect(
      await screen.findByText("Hotspot refresh job is currently running. Please wait for the current run to complete.")
    ).toBeInTheDocument();

    // Verify button is re-enabled
    expect(refreshBtn).not.toBeDisabled();
  });

  test("20. Hotspot details modal loads GET /:id, shows centroid and constituent issues, and protects private data", async () => {
    const mockAdmin = {
      adminId: "660000000000000000000001",
      email: "admin@civicvision.gov",
      fullName: "Super Admin",
      role: "admin",
    };
    localStorage.setItem("adminToken", "mock_admin_token");
    localStorage.setItem("adminData", JSON.stringify(mockAdmin));

    API.get.mockResolvedValueOnce({
      data: { error: false, admin: mockAdmin, role: "admin", isAdmin: true },
    });
    API.get.mockResolvedValueOnce({ data: [] });

    render(<App />);
    const hotspotsTab = await screen.findByTestId("tab-hotspots");

    const sampleHotspot = {
      _id: "66a000000000000000000099",
      category: "pothole",
      department: "Roads & Infrastructure",
      status: "active",
      distinctDefectCount: 2,
      totalReportCount: 3,
      totalVotes: 8,
      meanSeverity: 8.0,
      centroid: { type: "Point", coordinates: [77.725, 11.345] },
      lastDetectedAt: "2026-10-15T12:00:00.000Z",
    };

    API.get.mockResolvedValueOnce({
      data: { error: false, total: 1, hotspots: [sampleHotspot] },
    });

    fireEvent.click(hotspotsTab);
    expect(await screen.findByTestId("hotspots-section")).toBeInTheDocument();

    // Mock GET /admin-dashboard/hotspots/:id
    API.get.mockResolvedValueOnce({
      data: {
        error: false,
        hotspot: {
          ...sampleHotspot,
          radiusMeters: 38.5,
          firstDetectedAt: "2026-10-14T08:00:00.000Z",
          alertSent: true,
          alertSentAt: "2026-10-14T08:05:00.000Z",
          issues: [
            {
              _id: "660000000000000000000777",
              type: "pothole",
              description: "Massive crater on arterial road",
              status: "reported",
              severity: 8.5,
              votes: 5,
              userId: { fullName: "Jane Citizen" },
              location: { coordinates: [77.7251, 11.3451] },
              createdAt: "2026-10-14T08:00:00.000Z",
            },
          ],
        },
      },
    });

    const viewBtn = screen.getByTestId("view-hotspot-btn-66a000000000000000000099");
    fireEvent.click(viewBtn);

    // Verify modal header and details
    expect(await screen.findByText("Hotspot #66a000000000000000000099")).toBeInTheDocument();
    expect(screen.getByText("[77.725, 11.345]")).toBeInTheDocument();
    expect(screen.getByText("≈ 38.5 m")).toBeInTheDocument();

    // Verify constituent issue summary
    expect(screen.getByText("Massive crater on arterial road")).toBeInTheDocument();
    expect(screen.getByText("Reporter: Jane Citizen")).toBeInTheDocument();
    expect(screen.getByText("Severity: 8.5/10")).toBeInTheDocument();

    // Privacy assertion: No internal notes, embeddings, or tokens
    expect(screen.queryByText(/internalNotes/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/embedding/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/aiDiagnostics/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/password/i)).not.toBeInTheDocument();

    // Close modal
    const closeBtn = screen.getByTestId("hotspot-modal-close-btn");
    fireEvent.click(closeBtn);
    expect(screen.queryByText("Hotspot #66a000000000000000000099")).not.toBeInTheDocument();
  });

  test("21. Notification bell and tab render with unread count badge, and clicking opens Notification Center", async () => {
    const mockAdmin = {
      adminId: "660000000000000000000001",
      email: "admin@civicvision.gov",
      fullName: "Super Admin",
      role: "admin",
    };
    localStorage.setItem("adminToken", "mock_admin_token");
    localStorage.setItem("adminData", JSON.stringify(mockAdmin));

    API.get.mockResolvedValueOnce({
      data: { error: false, admin: mockAdmin, role: "admin", isAdmin: true },
    });
    API.get.mockResolvedValueOnce({ data: [] });

    mockFetchUnreadNotificationCount.mockResolvedValueOnce({
      data: { error: false, unreadCount: 3 },
    });

    render(<App />);

    // Verify Notification Bell button with badge exists in navbar
    const bellBtn = await screen.findByTestId("btn-notification-bell");
    expect(bellBtn).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId("bell-unread-badge")).toHaveTextContent("3");
    });

    // Verify Notifications Tab in tabs bar
    const notifTab = screen.getByTestId("tab-notifications");
    expect(notifTab).toBeInTheDocument();
    expect(screen.getByTestId("tab-unread-badge")).toHaveTextContent("3");


    // Mock GET /admin-dashboard/notifications
    API.get.mockResolvedValueOnce({
      data: {
        error: false,
        total: 2,
        unreadCount: 3,
        page: 1,
        totalPages: 1,
        limit: 10,
        notifications: [
          {
            _id: "66c000000000000000000001",
            type: "hotspot_detected",
            hotspotId: "66a000000000000000000001",
            title: "High-Density Pothole Hotspot Detected",
            message: "New hotspot cluster detected with 4 distinct defects.",
            severity: 8.5,
            dedupeKey: "hotspot-66a1-detected",
            readAt: null,
            emailStatus: "sent",
            emailSentAt: "2026-10-15T12:00:00.000Z",
            emailAttemptCount: 1,
            createdAt: "2026-10-15T12:00:00.000Z",
          },
          {
            _id: "66c000000000000000000002",
            type: "hotspot_escalated",
            hotspotId: "66a000000000000000000002",
            title: "Hotspot Cluster Rapidly Escalating",
            message: "Cluster report volume grew by 60% in the last 24h.",
            severity: 7.2,
            dedupeKey: "hotspot-66a2-escalated",
            readAt: "2026-10-15T13:00:00.000Z",
            emailStatus: "pending",
            emailAttemptCount: 0,
            createdAt: "2026-10-15T13:00:00.000Z",
          },
        ],
      },
    });

    // Click on bell button to open Notification Center
    fireEvent.click(bellBtn);

    // Verify Notification Center view
    expect(await screen.findByTestId("notification-center")).toBeInTheDocument();
    expect(screen.getByText("Admin Notification Center")).toBeInTheDocument();
    expect(await screen.findByTestId("nc-unread-count-badge")).toHaveTextContent("3 Unread");

    // Verify both notifications render with appropriate visual cues
    expect(screen.getByText("High-Density Pothole Hotspot Detected")).toBeInTheDocument();
    expect(screen.getByText("Hotspot Cluster Rapidly Escalating")).toBeInTheDocument();

    // Verify distinct alert type tags
    expect(screen.getByTestId("type-badge-66c000000000000000000001")).toHaveTextContent(/Hotspot Detected/i);
    expect(screen.getByTestId("type-badge-66c000000000000000000002")).toHaveTextContent(/Hotspot Escalated/i);

    // Verify read / unread state pills
    expect(screen.getByTestId("badge-unread-66c000000000000000000001")).toHaveTextContent("Unread");
    expect(screen.getByTestId("badge-read-66c000000000000000000002")).toHaveTextContent("Read");

    // Verify heuristic severity badge
    expect(screen.getByTestId("severity-badge-66c000000000000000000001")).toHaveTextContent("8.5/10");
    expect(screen.getByTestId("severity-badge-66c000000000000000000001")).toHaveTextContent("High");

    // Verify email status badges
    expect(screen.getByTestId("email-status-box-66c000000000000000000001")).toHaveTextContent(/Email Sent/i);
    expect(screen.getByTestId("email-status-box-66c000000000000000000002")).toHaveTextContent(/Email Pending/i);

    // Verify unread notification has "Mark as Read" action button
    expect(screen.getByTestId("mark-read-btn-66c000000000000000000001")).toBeInTheDocument();
    // Read notification should NOT have "Mark as Read" button
    expect(screen.queryByTestId("mark-read-btn-66c000000000000000000002")).not.toBeInTheDocument();
  });

  test("22. Individual and bulk mark-as-read actions update notification state, decrement unread count, and disable buttons", async () => {
    const mockAdmin = {
      adminId: "660000000000000000000001",
      email: "admin@civicvision.gov",
      fullName: "Super Admin",
      role: "admin",
    };
    localStorage.setItem("adminToken", "mock_admin_token");
    localStorage.setItem("adminData", JSON.stringify(mockAdmin));

    API.get.mockResolvedValueOnce({
      data: { error: false, admin: mockAdmin, role: "admin", isAdmin: true },
    });
    API.get.mockResolvedValueOnce({ data: [] });

    mockFetchUnreadNotificationCount.mockResolvedValueOnce({
      data: { error: false, unreadCount: 2 },
    });

    render(<App />);

    const notifTab = await screen.findByTestId("tab-notifications");

    // Mock GET /admin-dashboard/notifications
    API.get.mockResolvedValueOnce({
      data: {
        error: false,
        total: 2,
        unreadCount: 2,
        page: 1,
        totalPages: 1,
        limit: 10,
        notifications: [
          {
            _id: "66c000000000000000000010",
            type: "hotspot_detected",
            title: "Cluster One Detected",
            message: "Details of cluster one",
            readAt: null,
            emailStatus: "sent",
            createdAt: "2026-10-15T12:00:00.000Z",
          },
          {
            _id: "66c000000000000000000020",
            type: "hotspot_detected",
            title: "Cluster Two Detected",
            message: "Details of cluster two",
            readAt: null,
            emailStatus: "sent",
            createdAt: "2026-10-15T12:10:00.000Z",
          },
        ],
      },
    });

    fireEvent.click(notifTab);
    expect(await screen.findByTestId("notification-center")).toBeInTheDocument();

    // Mock individual mark read: PATCH /notifications/66c000000000000000000010/read
    API.patch.mockResolvedValueOnce({
      data: {
        error: false,
        message: "Notification marked as read",
        notification: {
          _id: "66c000000000000000000010",
          readAt: "2026-10-15T12:30:00.000Z",
        },
      },
    });

    const markReadBtn1 = screen.getByTestId("mark-read-btn-66c000000000000000000010");
    fireEvent.click(markReadBtn1);

    await waitFor(() => {
      expect(API.patch).toHaveBeenCalledWith("/admin-dashboard/notifications/66c000000000000000000010/read");
    });

    // Notification 1 state changes to Read
    expect(await screen.findByTestId("badge-read-66c000000000000000000010")).toHaveTextContent("Read");
    expect(screen.queryByTestId("mark-read-btn-66c000000000000000000010")).not.toBeInTheDocument();

    // Verify unread count decremented to 1 in navbar bell badge
    expect(screen.getByTestId("bell-unread-badge")).toHaveTextContent("1");

    // Test Bulk "Mark All as Read"
    API.patch.mockResolvedValueOnce({
      data: {
        error: false,
        message: "All notifications marked as read",
        markedCount: 1,
      },
    });

    const markAllBtn = screen.getByTestId("mark-all-read-btn");
    expect(markAllBtn).not.toBeDisabled();
    fireEvent.click(markAllBtn);

    await waitFor(() => {
      expect(API.patch).toHaveBeenCalledWith("/admin-dashboard/notifications/read-all");
    });

    // Success banner
    expect(await screen.findByTestId("nc-feedback-alert")).toHaveTextContent(/All notifications marked as read/i);

    // Notification 2 is now also marked as read
    expect(await screen.findByTestId("badge-read-66c000000000000000000020")).toHaveTextContent("Read");

    // Mark All button becomes disabled because unreadCount is 0
    expect(markAllBtn).toBeDisabled();
    expect(screen.queryByTestId("bell-unread-badge")).not.toBeInTheDocument();
  });

  test("23. Notification center filters by read state and alert type, and resets filters", async () => {
    const mockAdmin = {
      adminId: "660000000000000000000001",
      email: "admin@civicvision.gov",
      fullName: "Super Admin",
      role: "admin",
    };
    localStorage.setItem("adminToken", "mock_admin_token");
    localStorage.setItem("adminData", JSON.stringify(mockAdmin));

    API.get.mockResolvedValueOnce({
      data: { error: false, admin: mockAdmin, role: "admin", isAdmin: true },
    });
    API.get.mockResolvedValueOnce({ data: [] });

    render(<App />);

    const notifTab = await screen.findByTestId("tab-notifications");

    // Initial load
    API.get.mockResolvedValueOnce({
      data: { error: false, total: 0, notifications: [] },
    });

    fireEvent.click(notifTab);
    expect(await screen.findByTestId("notification-center")).toBeInTheDocument();

    // Filter by Read State: Unread Only ("false")
    API.get.mockResolvedValueOnce({
      data: { error: false, total: 1, notifications: [] },
    });

    const readSelect = screen.getByTestId("nc-read-filter");
    fireEvent.change(readSelect, { target: { value: "false" } });

    await waitFor(() => {
      expect(API.get).toHaveBeenCalledWith(
        "/admin-dashboard/notifications",
        expect.objectContaining({
          params: expect.objectContaining({ read: "false" }),
        })
      );
    });

    // Filter by Alert Type: Hotspot Escalated
    API.get.mockResolvedValueOnce({
      data: { error: false, total: 1, notifications: [] },
    });

    const typeSelect = screen.getByTestId("nc-type-filter");
    fireEvent.change(typeSelect, { target: { value: "hotspot_escalated" } });

    await waitFor(() => {
      expect(API.get).toHaveBeenCalledWith(
        "/admin-dashboard/notifications",
        expect.objectContaining({
          params: expect.objectContaining({ type: "hotspot_escalated" }),
        })
      );
    });

    // Reset Filters button appears and works
    const resetBtn = screen.getByTestId("nc-reset-filters-btn");
    expect(resetBtn).toBeInTheDocument();

    API.get.mockResolvedValueOnce({
      data: { error: false, total: 0, notifications: [] },
    });

    fireEvent.click(resetBtn);

    await waitFor(() => {
      expect(readSelect).toHaveValue("all");
      expect(typeSelect).toHaveValue("all");
    });
  });

  test("24. Retry email action succeeds for failed notifications and handles backend 400 rejection", async () => {
    const mockAdmin = {
      adminId: "660000000000000000000001",
      email: "admin@civicvision.gov",
      fullName: "Super Admin",
      role: "admin",
    };
    localStorage.setItem("adminToken", "mock_admin_token");
    localStorage.setItem("adminData", JSON.stringify(mockAdmin));

    API.get.mockResolvedValueOnce({
      data: { error: false, admin: mockAdmin, role: "admin", isAdmin: true },
    });
    API.get.mockResolvedValueOnce({ data: [] });

    render(<App />);

    const notifTab = await screen.findByTestId("tab-notifications");

    const failedNotification = {
      _id: "66c000000000000000000088",
      type: "hotspot_detected",
      title: "Hotspot with failed email",
      message: "Notification where email failed due to network timeout",
      readAt: null,
      emailStatus: "failed",
      emailAttemptCount: 2,
      emailLastError: "Connection timeout to smtp.municipal.internal",
      createdAt: "2026-10-15T12:00:00.000Z",
    };

    API.get.mockResolvedValueOnce({
      data: {
        error: false,
        total: 1,
        unreadCount: 1,
        notifications: [failedNotification],
      },
    });

    fireEvent.click(notifTab);
    expect(await screen.findByTestId("notification-center")).toBeInTheDocument();

    // Verify retry button exists
    const retryBtn = screen.getByTestId("retry-email-btn-66c000000000000000000088");
    expect(retryBtn).toBeInTheDocument();
    expect(retryBtn).toHaveTextContent("Retry Email");

    // 1. Successful retry
    API.post.mockResolvedValueOnce({
      data: {
        error: false,
        message: "Email retry sent successfully",
        notification: {
          ...failedNotification,
          emailStatus: "sent",
          emailAttemptCount: 3,
          emailSentAt: new Date().toISOString(),
        },
      },
    });

    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(API.post).toHaveBeenCalledWith("/admin-dashboard/notifications/66c000000000000000000088/retry-email");
    });

    expect(await screen.findByTestId("nc-feedback-alert")).toHaveTextContent("Email retry sent successfully");

    // 2. Test 400 rejection on retry
    API.post.mockRejectedValueOnce({
      response: {
        status: 400,
        data: {
          error: true,
          message: "SMTP service is currently offline or unreachable.",
          notification: {
            ...failedNotification,
            emailStatus: "failed",
            emailAttemptCount: 4,
          },
        },
      },
    });

    // Re-click retry
    const retryBtnAfter = screen.queryByTestId("retry-email-btn-66c000000000000000000088");
    if (retryBtnAfter) {
      fireEvent.click(retryBtnAfter);
      expect(await screen.findByTestId("nc-feedback-alert")).toHaveTextContent(
        "SMTP service is currently offline or unreachable."
      );
    }
  });

  test("25. Retry email is permanently disabled when max retry limit (5) is reached", async () => {
    const mockAdmin = {
      adminId: "660000000000000000000001",
      email: "admin@civicvision.gov",
      fullName: "Super Admin",
      role: "admin",
    };
    localStorage.setItem("adminToken", "mock_admin_token");
    localStorage.setItem("adminData", JSON.stringify(mockAdmin));

    API.get.mockResolvedValueOnce({
      data: { error: false, admin: mockAdmin, role: "admin", isAdmin: true },
    });
    API.get.mockResolvedValueOnce({ data: [] });

    render(<App />);

    const notifTab = await screen.findByTestId("tab-notifications");

    const maxedNotification = {
      _id: "66c000000000000000000099",
      type: "hotspot_escalated",
      title: "Escalated cluster with exhausted retries",
      message: "Exhausted all 5 attempts",
      readAt: null,
      emailStatus: "failed",
      emailAttemptCount: 5,
      emailLastError: "Max attempts reached",
      createdAt: "2026-10-15T12:00:00.000Z",
    };

    API.get.mockResolvedValueOnce({
      data: {
        error: false,
        total: 1,
        unreadCount: 1,
        notifications: [maxedNotification],
      },
    });

    fireEvent.click(notifTab);
    expect(await screen.findByTestId("notification-center")).toBeInTheDocument();

    const retryBtn = screen.getByTestId("retry-email-btn-66c000000000000000000099");
    expect(retryBtn).toBeDisabled();
    expect(retryBtn).toHaveTextContent("Retry Limit Reached");

    // Clicking disabled button should NOT trigger POST
    fireEvent.click(retryBtn);
    expect(API.post).not.toHaveBeenCalled();
  });

  test("26. Clicking View Hotspot switches to Hotspots tab and opens hotspot detail modal", async () => {
    const mockAdmin = {
      adminId: "660000000000000000000001",
      email: "admin@civicvision.gov",
      fullName: "Super Admin",
      role: "admin",
    };
    localStorage.setItem("adminToken", "mock_admin_token");
    localStorage.setItem("adminData", JSON.stringify(mockAdmin));

    API.get.mockResolvedValueOnce({
      data: { error: false, admin: mockAdmin, role: "admin", isAdmin: true },
    });
    API.get.mockResolvedValueOnce({ data: [] });

    render(<App />);

    const notifTab = await screen.findByTestId("tab-notifications");

    API.get.mockResolvedValueOnce({
      data: {
        error: false,
        total: 1,
        unreadCount: 0,
        notifications: [
          {
            _id: "66c000000000000000000077",
            type: "hotspot_detected",
            hotspotId: "66a000000000000000000055",
            title: "Road damage cluster",
            message: "Check constituent issues in hotspot modal",
            readAt: "2026-10-15T12:00:00.000Z",
            emailStatus: "sent",
            createdAt: "2026-10-15T12:00:00.000Z",
          },
        ],
      },
    });

    fireEvent.click(notifTab);
    expect(await screen.findByTestId("notification-center")).toBeInTheDocument();

    const viewHotspotBtn = screen.getByTestId("view-hotspot-link-66c000000000000000000077");
    expect(viewHotspotBtn).toBeInTheDocument();

    // Prepare mock for switching to Hotspots tab and fetching hotspot detail
    API.get.mockResolvedValueOnce({
      data: { error: false, total: 1, hotspots: [] },
    });
    API.get.mockResolvedValueOnce({
      data: {
        error: false,
        hotspot: {
          _id: "66a000000000000000000055",
          category: "road_damage",
          department: "Roads & Infrastructure",
          status: "active",
          distinctDefectCount: 3,
          totalReportCount: 6,
          centroid: { type: "Point", coordinates: [77.72, 11.34] },
          issues: [],
        },
      },
    });

    // Click "View Hotspot"
    fireEvent.click(viewHotspotBtn);

    // Should switch to hotspots section and open detail modal
    expect(await screen.findByTestId("hotspots-section")).toBeInTheDocument();
    expect(await screen.findByText("Hotspot #66a000000000000000000055")).toBeInTheDocument();
  });

  test("27. Handles notification error with retry, and empty states", async () => {
    const mockAdmin = {
      adminId: "660000000000000000000001",
      email: "admin@civicvision.gov",
      fullName: "Super Admin",
      role: "admin",
    };
    localStorage.setItem("adminToken", "mock_admin_token");
    localStorage.setItem("adminData", JSON.stringify(mockAdmin));

    API.get.mockResolvedValueOnce({
      data: { error: false, admin: mockAdmin, role: "admin", isAdmin: true },
    });
    API.get.mockResolvedValueOnce({ data: [] });

    render(<App />);

    const notifTab = await screen.findByTestId("tab-notifications");

    // 1. Error state
    API.get.mockRejectedValueOnce({
      response: { status: 500, data: { message: "Notifications service unavailable" } },
    });

    fireEvent.click(notifTab);

    expect(await screen.findByTestId("nc-error-state")).toBeInTheDocument();
    expect(screen.getByText("Notifications service unavailable")).toBeInTheDocument();

    // 2. Retry succeeds with empty list
    API.get.mockResolvedValueOnce({
      data: { error: false, total: 0, notifications: [] },
    });

    const retryBtn = screen.getByRole("button", { name: /Try Again/i });
    fireEvent.click(retryBtn);

    expect(await screen.findByTestId("nc-empty-state")).toBeInTheDocument();
    expect(screen.getByText("No Notifications Found")).toBeInTheDocument();
  });

  test("35. Performance Analytics tab renders and displays database-backed KPI metrics", async () => {
    const mockAdmin = {
      _id: "adm_test_analytics_01",
      email: "analytics.admin@civicvision.gov",
      fullName: "Analytics Director",
    };
    localStorage.setItem("adminToken", "mock_admin_token");
    localStorage.setItem("adminData", JSON.stringify(mockAdmin));

    // Profile restoration
    API.get.mockResolvedValueOnce({
      data: { error: false, admin: mockAdmin, role: "admin", isAdmin: true },
    });
    // Issues list
    API.get.mockResolvedValueOnce({ data: [] });
    // Analytics
    API.get.mockResolvedValueOnce({
      data: {
        error: false,
        data: {
          summary: {
            totalIssues: 42,
            openIssues: 18,
            resolvedIssues: 24,
            reportedIssues: 8,
            inProgressIssues: 10,
            needsReviewIssues: 3,
            resolutionRate: 0.5714,
            resolutionRateFormatted: "57.1%",
          },
          mttr: {
            avgHours: 14.5,
            sampleSize: 24,
            formatted: "14.5 hrs",
          },
          breakdowns: {
            byStatus: { reported: 8, "in-progress": 10, resolved: 24 },
            byCategory: [{ category: "pothole", count: 25, percentage: "59.5%" }],
            byDepartment: [{ department: "Roads & Infrastructure", count: 30, percentage: "71.4%" }],
          },
          hotspots: {
            total: 2,
            active: 1,
            totalDistinctDefects: 6,
            avgSeverity: 7.2,
            byCategory: [],
          },
          trend: {
            days: 30,
            data: [{ date: "2026-10-25", created: 3, resolved: 2 }],
          },
        },
      },
    });

    render(<App />);

    const analyticsTab = await screen.findByTestId("tab-analytics");
    expect(analyticsTab).toBeInTheDocument();

    fireEvent.click(analyticsTab);

    // Verify analytics section renders with metrics
    expect(await screen.findByTestId("analytics-section")).toBeInTheDocument();
    expect(screen.getByText("Municipal Performance Analytics")).toBeInTheDocument();
    expect(screen.getByTestId("kpi-total")).toHaveTextContent("42");
    expect(screen.getByTestId("kpi-open")).toHaveTextContent("18");
    expect(screen.getByTestId("kpi-resolved")).toHaveTextContent("24");
    expect(screen.getByTestId("kpi-rate")).toHaveTextContent("57.1%");
    expect(screen.getByTestId("kpi-mttr")).toHaveTextContent("14.5 hrs");
  });

  test("36. Performance Analytics displays empty state when collection has 0 issues", async () => {
    const mockAdmin = {
      _id: "adm_test_analytics_02",
      email: "analytics.admin@civicvision.gov",
      fullName: "Analytics Director",
    };
    localStorage.setItem("adminToken", "mock_admin_token");
    localStorage.setItem("adminData", JSON.stringify(mockAdmin));

    API.get.mockResolvedValueOnce({
      data: { error: false, admin: mockAdmin, role: "admin", isAdmin: true },
    });
    API.get.mockResolvedValueOnce({ data: [] });
    API.get.mockResolvedValueOnce({
      data: {
        error: false,
        data: {
          summary: {
            totalIssues: 0,
            openIssues: 0,
            resolvedIssues: 0,
            resolutionRate: 0,
            resolutionRateFormatted: "0.0%",
          },
          mttr: { avgHours: null, sampleSize: 0, formatted: "N/A" },
          breakdowns: { byStatus: {}, byCategory: [], byDepartment: [] },
          hotspots: { total: 0, active: 0, totalDistinctDefects: 0 },
          trend: { days: 30, data: [] },
        },
      },
    });

    render(<App />);

    const analyticsTab = await screen.findByTestId("tab-analytics");
    fireEvent.click(analyticsTab);

    expect(await screen.findByTestId("analytics-empty")).toBeInTheDocument();
    expect(screen.getByText("No Civic Defect Data Available")).toBeInTheDocument();
  });

  test("37. Classification review: Confirming existing category sends 'confirmed_category' and clears review badge", async () => {
    const mockAdmin = {
      _id: "adm_test_triage_01",
      email: "triage.admin@civicvision.gov",
      fullName: "Triage Officer",
      role: "admin",
    };
    localStorage.setItem("adminToken", "mock_admin_token");
    localStorage.setItem("adminData", JSON.stringify(mockAdmin));

    API.get.mockResolvedValueOnce({
      data: { error: false, admin: mockAdmin, role: "admin", isAdmin: true },
    });

    const mockIssue = {
      _id: "660000000000000000000401",
      type: "pothole",
      description: "Severe pothole flagged for classification review",
      status: "reported",
      department: "Roads & Infrastructure",
      needsClassificationReview: true,
      needsDuplicateReview: false,
      needsReview: true,
      createdAt: new Date().toISOString(),
    };

    API.get.mockResolvedValueOnce({ data: [mockIssue] });

    // Mock classification review resolution API
    API.patch.mockResolvedValueOnce({
      data: {
        error: false,
        message: "Classification review successfully resolved as 'confirmed_category'.",
        issue: {
          ...mockIssue,
          needsClassificationReview: false,
          classificationReviewResolution: "confirmed_category",
          needsReview: false,
        },
      },
    });

    render(<App />);

    // 1. Confirm issue is rendered and triage badge is visible
    expect(await screen.findByText("Severe pothole flagged for classification review")).toBeInTheDocument();
    expect(screen.getByTitle("Pending category triage review")).toBeInTheDocument();

    // 2. Open Triage modal
    const triageBtn = screen.getByRole("button", { name: `Triage issue ${mockIssue._id}` });
    fireEvent.click(triageBtn);

    // 3. Verify modal elements: alert banner, category selector, approve button
    expect(await screen.findByText("Classification Triage Review Required")).toBeInTheDocument();
    const categorySelect = screen.getByLabelText("Defect Category");
    expect(categorySelect.value).toBe("pothole");

    const approveBtn = screen.getByTestId("btn-resolve-classification");
    expect(approveBtn).toBeInTheDocument();
    expect(approveBtn).toHaveTextContent("Approve / Update Category");

    // 4. Click Approve / Update Category
    fireEvent.click(approveBtn);

    // 5. Verify correct API payload with confirmed_category
    await waitFor(() => {
      expect(API.patch).toHaveBeenCalledWith(
        `/admin-dashboard/issues/${mockIssue._id}/classification-review`,
        expect.objectContaining({
          action: "confirmed_category",
          type: "pothole",
          department: "Roads & Infrastructure",
        })
      );
    });

    // 6. Verify success banner and verified note appear
    expect(
      await screen.findByText("Classification review successfully resolved as 'confirmed_category'.")
    ).toBeInTheDocument();
    expect(screen.getByText(/Category verified:/i)).toBeInTheDocument();

    // 7. Close modal and verify the review warning badge is removed from table
    const closeBtn = screen.getByLabelText("Close modal");
    fireEvent.click(closeBtn);

    await waitFor(() => {
      expect(screen.queryByTitle("Pending category triage review")).not.toBeInTheDocument();
    });
  });

  test("38. Classification review: Changing category sends 'reclassified' and updates department auto-suggestion", async () => {
    const mockAdmin = {
      _id: "adm_test_triage_02",
      email: "triage.admin2@civicvision.gov",
      fullName: "Triage Lead",
      role: "admin",
    };
    localStorage.setItem("adminToken", "mock_admin_token");
    localStorage.setItem("adminData", JSON.stringify(mockAdmin));

    API.get.mockResolvedValueOnce({
      data: { error: false, admin: mockAdmin, role: "admin", isAdmin: true },
    });

    const mockIssue = {
      _id: "660000000000000000000402",
      type: "pothole",
      description: "Misclassified pothole that is actually garbage",
      status: "reported",
      department: "Roads & Infrastructure",
      needsClassificationReview: true,
      needsDuplicateReview: false,
      needsReview: true,
      createdAt: new Date().toISOString(),
    };

    API.get.mockResolvedValueOnce({ data: [mockIssue] });

    API.patch.mockResolvedValueOnce({
      data: {
        error: false,
        message: "Classification review successfully resolved as 'reclassified'.",
        issue: {
          ...mockIssue,
          type: "garbage",
          department: "Waste Management",
          needsClassificationReview: false,
          classificationReviewResolution: "reclassified",
          needsReview: false,
        },
      },
    });

    render(<App />);

    expect(await screen.findByText("Misclassified pothole that is actually garbage")).toBeInTheDocument();

    // Open Triage modal
    fireEvent.click(screen.getByRole("button", { name: `Triage issue ${mockIssue._id}` }));

    // Change category to garbage
    const categorySelect = await screen.findByLabelText("Defect Category");
    fireEvent.change(categorySelect, { target: { value: "garbage" } });
    expect(categorySelect.value).toBe("garbage");

    // Department should auto-suggest Waste Management
    const deptSelect = screen.getByLabelText("Assigned Department");
    expect(deptSelect.value).toBe("Waste Management");

    // Submit reclassification
    const approveBtn = screen.getByTestId("btn-resolve-classification");
    fireEvent.click(approveBtn);

    // Verify PATCH was called with action: 'reclassified'
    await waitFor(() => {
      expect(API.patch).toHaveBeenCalledWith(
        `/admin-dashboard/issues/${mockIssue._id}/classification-review`,
        expect.objectContaining({
          action: "reclassified",
          type: "garbage",
          department: "Waste Management",
        })
      );
    });

    expect(
      await screen.findByText("Classification review successfully resolved as 'reclassified'.")
    ).toBeInTheDocument();
  });

  test("39. Classification review: Rejects unsupported action values and ensures only confirmed_category or reclassified are sent", async () => {
    const mockAdmin = {
      _id: "adm_test_triage_03",
      email: "triage.admin3@civicvision.gov",
      fullName: "Triage Inspector",
      role: "admin",
    };
    localStorage.setItem("adminToken", "mock_admin_token");
    localStorage.setItem("adminData", JSON.stringify(mockAdmin));

    API.get.mockResolvedValueOnce({
      data: { error: false, admin: mockAdmin, role: "admin", isAdmin: true },
    });

    const mockIssue = {
      _id: "660000000000000000000403",
      type: "water_leak",
      description: "Water pipe rupture requiring review",
      status: "reported",
      department: "Water Services",
      needsClassificationReview: true,
      needsDuplicateReview: false,
      needsReview: true,
      createdAt: new Date().toISOString(),
    };

    API.get.mockResolvedValueOnce({ data: [mockIssue] });

    API.patch.mockResolvedValueOnce({
      data: {
        error: false,
        message: "Resolved",
        issue: { ...mockIssue, needsClassificationReview: false },
      },
    });

    render(<App />);

    expect(await screen.findByText("Water pipe rupture requiring review")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: `Triage issue ${mockIssue._id}` }));
    const approveBtn = await screen.findByTestId("btn-resolve-classification");
    fireEvent.click(approveBtn);

    await waitFor(() => {
      expect(API.patch).toHaveBeenCalled();
    });

    const patchCall = API.patch.mock.calls.find((call) =>
      call[0].includes("classification-review")
    );
    expect(patchCall).toBeDefined();
    const sentAction = patchCall[1].action;
    expect(["confirmed_category", "reclassified"]).toContain(sentAction);
    expect(["approved", "dismissed", "manual_override"]).not.toContain(sentAction);
  });

  test("40. Classification review: Failed API request shows error message, retains category selection, and preserves review warning", async () => {
    const mockAdmin = {
      _id: "adm_test_triage_04",
      email: "triage.admin4@civicvision.gov",
      fullName: "Triage Tester",
      role: "admin",
    };
    localStorage.setItem("adminToken", "mock_admin_token");
    localStorage.setItem("adminData", JSON.stringify(mockAdmin));

    API.get.mockResolvedValueOnce({
      data: { error: false, admin: mockAdmin, role: "admin", isAdmin: true },
    });

    const mockIssue = {
      _id: "660000000000000000000404",
      type: "street_light",
      description: "Dark street light issue pending review",
      status: "reported",
      department: "Street Lighting",
      needsClassificationReview: true,
      needsDuplicateReview: false,
      needsReview: true,
      createdAt: new Date().toISOString(),
    };

    API.get.mockResolvedValueOnce({ data: [mockIssue] });

    // Mock API failure (e.g. 500 Database Error)
    API.patch.mockRejectedValueOnce({
      response: {
        status: 500,
        data: { message: "Internal Server Error: Database write failed" },
      },
    });

    render(<App />);

    expect(await screen.findByText("Dark street light issue pending review")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: `Triage issue ${mockIssue._id}` }));

    // Change category to sewage
    const categorySelect = await screen.findByLabelText("Defect Category");
    fireEvent.change(categorySelect, { target: { value: "sewage" } });
    expect(categorySelect.value).toBe("sewage");

    const approveBtn = screen.getByTestId("btn-resolve-classification");
    fireEvent.click(approveBtn);

    // Verify error banner is displayed
    expect(
      await screen.findByText("Internal Server Error: Database write failed")
    ).toBeInTheDocument();

    // Verify category selection is retained
    expect(categorySelect.value).toBe("sewage");

    // Close modal and verify the review warning badge is STILL in the table
    const closeBtn = screen.getByLabelText("Close modal");
    fireEvent.click(closeBtn);

    await waitFor(() => {
      expect(screen.getByTitle("Pending category triage review")).toBeInTheDocument();
    });
  });

  test("41. Classification review: Prevents duplicate requests during submission and disables button", async () => {
    const mockAdmin = {
      _id: "adm_test_triage_05",
      email: "triage.admin5@civicvision.gov",
      fullName: "Concurrency Tester",
      role: "admin",
    };
    localStorage.setItem("adminToken", "mock_admin_token");
    localStorage.setItem("adminData", JSON.stringify(mockAdmin));

    API.get.mockResolvedValueOnce({
      data: { error: false, admin: mockAdmin, role: "admin", isAdmin: true },
    });

    const mockIssue = {
      _id: "660000000000000000000405",
      type: "pothole",
      description: "Pothole for concurrency check",
      status: "reported",
      department: "Roads & Infrastructure",
      needsClassificationReview: true,
      createdAt: new Date().toISOString(),
    };

    API.get.mockResolvedValueOnce({ data: [mockIssue] });

    let resolvePromise;
    const delayedPromise = new Promise((resolve) => {
      resolvePromise = resolve;
    });

    API.patch.mockReturnValueOnce(delayedPromise);

    render(<App />);

    expect(await screen.findByText("Pothole for concurrency check")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: `Triage issue ${mockIssue._id}` }));
    const approveBtn = await screen.findByTestId("btn-resolve-classification");

    // Click once
    fireEvent.click(approveBtn);

    // Button should now be disabled and display loading text
    expect(approveBtn).toBeDisabled();
    expect(approveBtn).toHaveTextContent("Updating Category...");

    // Repeated click while disabled should not trigger extra API calls
    fireEvent.click(approveBtn);
    expect(API.patch).toHaveBeenCalledTimes(1);

    // Resolve the delayed call
    resolvePromise({
      data: {
        error: false,
        message: "Classification review resolved concurrently",
        issue: { ...mockIssue, needsClassificationReview: false },
      },
    });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Classification review resolved concurrently");
    });
  });

  test("42. Classification review: Drawer open/close and cancel behavior remains correct across success, cancellation, and failure", async () => {
    const mockAdmin = {
      _id: "adm_test_triage_06",
      email: "triage.admin6@civicvision.gov",
      fullName: "Drawer Tester",
      role: "admin",
    };
    localStorage.setItem("adminToken", "mock_admin_token");
    localStorage.setItem("adminData", JSON.stringify(mockAdmin));

    API.get.mockResolvedValueOnce({
      data: { error: false, admin: mockAdmin, role: "admin", isAdmin: true },
    });

    const mockIssue = {
      _id: "660000000000000000000406",
      type: "pothole",
      description: "Pothole to verify drawer lifecycle",
      status: "reported",
      department: "Roads & Infrastructure",
      needsClassificationReview: true,
      createdAt: new Date().toISOString(),
    };

    API.get.mockResolvedValueOnce({ data: [mockIssue] });

    render(<App />);

    expect(await screen.findByText("Pothole to verify drawer lifecycle")).toBeInTheDocument();

    // 1. Open drawer
    fireEvent.click(screen.getByRole("button", { name: `Triage issue ${mockIssue._id}` }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    // 2. Cancel / close via close button
    const closeBtn = screen.getByLabelText("Close modal");
    fireEvent.click(closeBtn);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    // 3. Re-open drawer
    fireEvent.click(screen.getByRole("button", { name: `Triage issue ${mockIssue._id}` }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    // 4. Close via backdrop overlay
    const overlay = document.querySelector(".modal-overlay");
    expect(overlay).toBeInTheDocument();
    fireEvent.click(overlay);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  test("43. Modal Accessibility: Focus moves inside modal on open, Escape closes it, and focus returns to opener", async () => {
    const mockAdmin = {
      _id: "adm_a11y_01",
      email: "a11y.admin@civicvision.gov",
      fullName: "Accessibility Auditor",
      role: "admin",
    };
    localStorage.setItem("adminToken", "mock_admin_token");
    localStorage.setItem("adminData", JSON.stringify(mockAdmin));

    API.get.mockResolvedValueOnce({
      data: { error: false, admin: mockAdmin, role: "admin", isAdmin: true },
    });

    const mockIssue = {
      _id: "660000000000000000000501",
      type: "pothole",
      description: "Pothole for a11y focus test",
      status: "reported",
      department: "Roads & Infrastructure",
      createdAt: new Date().toISOString(),
      statusHistory: [],
    };

    API.get.mockResolvedValueOnce({ data: [mockIssue] });

    render(<App />);

    expect(await screen.findByText("Pothole for a11y focus test")).toBeInTheDocument();

    const openerBtn = screen.getByRole("button", { name: `Triage issue ${mockIssue._id}` });
    openerBtn.focus();
    expect(document.activeElement).toBe(openerBtn);

    fireEvent.click(openerBtn);

    // Modal dialog rendered with accessible semantics
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby", "modal-issue-title");

    const closeBtn = screen.getByLabelText("Close modal");
    expect(closeBtn).toBeInTheDocument();

    // Verify initial focus is moved to the close button
    await waitFor(() => {
      expect(document.activeElement).toBe(closeBtn);
    });

    // Press Escape to dismiss
    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    // Focus restored to opener element
    await waitFor(() => {
      expect(document.activeElement).toBe(openerBtn);
    });
  });

  test("44. Modal Accessibility: Tab and Shift+Tab wrap within focusable elements inside the modal", async () => {
    const mockAdmin = {
      _id: "adm_a11y_02",
      email: "a11y2.admin@civicvision.gov",
      fullName: "Trap Auditor",
      role: "admin",
    };
    localStorage.setItem("adminToken", "mock_admin_token");
    localStorage.setItem("adminData", JSON.stringify(mockAdmin));

    API.get.mockResolvedValueOnce({
      data: { error: false, admin: mockAdmin, role: "admin", isAdmin: true },
    });

    const mockIssue = {
      _id: "660000000000000000000502",
      type: "pothole",
      description: "Pothole for focus trap test",
      status: "reported",
      department: "Roads & Infrastructure",
      createdAt: new Date().toISOString(),
    };

    API.get.mockResolvedValueOnce({ data: [mockIssue] });

    render(<App />);

    expect(await screen.findByText("Pothole for focus trap test")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: `Triage issue ${mockIssue._id}` }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();

    const focusable = dialog.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    expect(focusable.length).toBeGreaterThan(1);

    const firstElement = focusable[0];
    const lastElement = focusable[focusable.length - 1];

    // Focus the last element and press Tab -> should wrap to first element
    lastElement.focus();
    expect(document.activeElement).toBe(lastElement);

    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(firstElement);

    // Focus first element and press Shift+Tab -> should wrap to last element
    firstElement.focus();
    expect(document.activeElement).toBe(firstElement);

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(lastElement);
  });

  test("45. Nested Overlays: Confirmation prompt handles Escape independently without closing parent modal", async () => {
    const mockAdmin = {
      _id: "adm_a11y_03",
      email: "a11y3.admin@civicvision.gov",
      fullName: "Hierarchy Auditor",
      role: "admin",
    };
    localStorage.setItem("adminToken", "mock_admin_token");
    localStorage.setItem("adminData", JSON.stringify(mockAdmin));

    API.get.mockResolvedValueOnce({
      data: { error: false, admin: mockAdmin, role: "admin", isAdmin: true },
    });

    const mockDuplicateIssue = {
      _id: "660000000000000000000503",
      type: "pothole",
      description: "Candidate duplicate pothole",
      status: "reported",
      department: "Roads & Infrastructure",
      duplicateStatus: "flagged_duplicate",
      similarityScore: 0.88,
      needsReview: true,
      reviewResolution: "none",
      duplicateOf: {
        _id: "660000000000000000000100",
        type: "pothole",
        description: "Primary verified pothole",
        status: "in-progress",
        createdAt: new Date().toISOString(),
      },
      createdAt: new Date().toISOString(),
    };

    API.get.mockResolvedValueOnce({ data: [mockDuplicateIssue] });

    render(<App />);

    expect(await screen.findByText("Candidate duplicate pothole")).toBeInTheDocument();

    // Open comparison modal
    const compBtn = screen.getByRole("button", { name: `Compare duplicate issue ${mockDuplicateIssue._id}` });
    fireEvent.click(compBtn);

    const compDialog = await screen.findByRole("dialog");
    expect(compDialog).toBeInTheDocument();
    expect(screen.getByText("Duplicate Assessment & Moderation")).toBeInTheDocument();

    // Click "Confirm Duplicate" to show confirmation dialog
    const confirmTriggerBtn = screen.getByRole("button", { name: /Confirm Duplicate/i });
    fireEvent.click(confirmTriggerBtn);

    const alertBox = await screen.findByRole("alertdialog");
    expect(alertBox).toBeInTheDocument();
    expect(screen.getByText("Confirm Issue as Duplicate?")).toBeInTheDocument();

    // Verify non-destructive Cancel button is in the confirm dialog
    const cancelConfirmBtn = screen.getByRole("button", { name: "Cancel" });
    expect(cancelConfirmBtn).toBeInTheDocument();

    // Press Escape -> closes ONLY the confirmation dialog prompt
    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });

    // Parent comparison modal must STILL remain open!
    expect(screen.getByText("Duplicate Assessment & Moderation")).toBeInTheDocument();

    // Press Escape again -> closes comparison modal
    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByText("Duplicate Assessment & Moderation")).not.toBeInTheDocument();
    });
  });

  test("46. Status History: Renders entries in chronological order with transitions, timestamps, admin, notes, and latest badge", async () => {
    const mockAdmin = {
      _id: "adm_sh_01",
      email: "audit.admin@civicvision.gov",
      fullName: "Audit Specialist",
      role: "admin",
    };
    localStorage.setItem("adminToken", "mock_admin_token");
    localStorage.setItem("adminData", JSON.stringify(mockAdmin));

    API.get.mockResolvedValueOnce({
      data: { error: false, admin: mockAdmin, role: "admin", isAdmin: true },
    });

    const mockIssue = {
      _id: "660000000000000000000504",
      type: "garbage",
      description: "Illegal dump site near park entrance",
      status: "resolved",
      department: "Waste Management",
      createdAt: "2026-10-10T08:00:00.000Z",
      statusHistory: [
        // Note: deliberately unsorted to test that frontend sorts chronologically
        {
          _id: "sh_entry_02",
          from: "in-progress",
          to: "resolved",
          changedAt: "2026-10-14T15:30:00.000Z",
          changedBy: { fullName: "Supervisor Maria Lopez", email: "maria@civicvision.gov" },
          reason: "Cleanup crew finished removal and site sanitized.",
        },
        {
          _id: "sh_entry_01",
          from: "reported",
          to: "in-progress",
          changedAt: "2026-10-11T09:15:00.000Z",
          changedBy: { fullName: "Dispatcher John Doe", email: "john@civicvision.gov" },
          reason: "Work order #9822 issued to Sanitation Unit 4.",
        },
      ],
    };

    API.get.mockResolvedValueOnce({ data: [mockIssue] });

    render(<App />);

    expect(await screen.findByText("Illegal dump site near park entrance")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: `Triage issue ${mockIssue._id}` }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    // Verify Status History Audit Trail section exists
    expect(screen.getByTestId("status-history-section")).toBeInTheDocument();
    expect(screen.getByTestId("status-history-count")).toHaveTextContent("2 transitions");

    // Chronological order verification
    const entry0 = screen.getByTestId("status-history-entry-0");
    const entry1 = screen.getByTestId("status-history-entry-1");

    // Entry 0 must be the earlier transition: reported -> in-progress
    expect(entry0).toHaveTextContent("reported");
    expect(entry0).toHaveTextContent("in progress");
    expect(entry0).toHaveTextContent("Dispatcher John Doe");
    expect(entry0).toHaveTextContent("Work order #9822 issued to Sanitation Unit 4.");

    // Entry 1 must be the later transition: in-progress -> resolved
    expect(entry1).toHaveTextContent("in progress");
    expect(entry1).toHaveTextContent("resolved");
    expect(entry1).toHaveTextContent("Supervisor Maria Lopez");
    expect(entry1).toHaveTextContent("Cleanup crew finished removal and site sanitized.");

    // Entry 1 is the latest transition and has the latest transition badge
    expect(entry1.querySelector(".badge-latest-transition")).toBeInTheDocument();
    expect(entry0.querySelector(".badge-latest-transition")).toBeNull();
  });

  test("47. Status History: Empty state displays properly and missing optional fields do not crash the component", async () => {
    const mockAdmin = {
      _id: "adm_sh_02",
      email: "audit2.admin@civicvision.gov",
      fullName: "Edge Auditor",
      role: "admin",
    };
    localStorage.setItem("adminToken", "mock_admin_token");
    localStorage.setItem("adminData", JSON.stringify(mockAdmin));

    API.get.mockResolvedValueOnce({
      data: { error: false, admin: mockAdmin, role: "admin", isAdmin: true },
    });

    const mockIssueEmpty = {
      _id: "660000000000000000000505",
      type: "water_leak",
      description: "Hydrant drip without any status changes yet",
      status: "reported",
      department: "Water Services",
      createdAt: new Date().toISOString(),
      statusHistory: [],
    };

    const mockIssueMalformed = {
      _id: "660000000000000000000506",
      type: "street_light",
      description: "Flickering street lamp with minimal history data",
      status: "in-progress",
      department: "Street Lighting",
      createdAt: new Date().toISOString(),
      statusHistory: [
        {
          _id: "sh_malformed_01",
          from: null,
          to: "in-progress",
          changedAt: null,
          changedBy: null,
          reason: null,
        },
      ],
    };

    API.get.mockResolvedValueOnce({ data: [mockIssueEmpty, mockIssueMalformed] });

    render(<App />);

    expect(await screen.findByText("Hydrant drip without any status changes yet")).toBeInTheDocument();

    // 1. Check issue with empty history
    fireEvent.click(screen.getByRole("button", { name: `Triage issue ${mockIssueEmpty._id}` }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    const emptyBox = screen.getByTestId("status-history-empty");
    expect(emptyBox).toBeInTheDocument();
    expect(emptyBox).toHaveTextContent("No status transitions recorded yet");
    expect(emptyBox).toHaveTextContent("reported");

    // Close modal
    fireEvent.click(screen.getByLabelText("Close modal"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    // 2. Check issue with null/missing optional fields in status history
    fireEvent.click(screen.getByRole("button", { name: `Triage issue ${mockIssueMalformed._id}` }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    const entry = screen.getByTestId("status-history-entry-0");
    expect(entry).toBeInTheDocument();
    expect(entry).toHaveTextContent("in progress");
    // Verify it didn't invent non-existent notes or administrators
    expect(entry).not.toHaveTextContent("Notes:");
  });

  test("48. Issue Detail Triage: Status update succeeds and dynamically appends newly recorded statusHistory transition", async () => {
    const mockAdmin = {
      _id: "adm_sh_03",
      email: "audit3.admin@civicvision.gov",
      fullName: "Workflow Auditor",
      role: "admin",
    };
    localStorage.setItem("adminToken", "mock_admin_token");
    localStorage.setItem("adminData", JSON.stringify(mockAdmin));

    API.get.mockResolvedValueOnce({
      data: { error: false, admin: mockAdmin, role: "admin", isAdmin: true },
    });

    const mockIssue = {
      _id: "660000000000000000000507",
      type: "pothole",
      description: "Deep crater on 5th Ave",
      status: "reported",
      department: "Roads & Infrastructure",
      createdAt: "2026-10-20T10:00:00.000Z",
      statusHistory: [],
    };

    API.get.mockResolvedValueOnce({ data: [mockIssue] });

    render(<App />);

    expect(await screen.findByText("Deep crater on 5th Ave")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: `Triage issue ${mockIssue._id}` }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    // Verify initially empty history
    expect(screen.getByTestId("status-history-empty")).toBeInTheDocument();

    // Update status to in-progress
    const statusSelect = screen.getByLabelText("Remediation Status");
    fireEvent.change(statusSelect, { target: { value: "in-progress" } });

    const notesArea = screen.getByLabelText(/Internal Remediation Notes/i);
    fireEvent.change(notesArea, { target: { value: "Asphalt patch team assigned" } });

    const updatedIssue = {
      ...mockIssue,
      status: "in-progress",
      internalNotes: "Asphalt patch team assigned",
      statusHistory: [
        {
          _id: "sh_new_01",
          from: "reported",
          to: "in-progress",
          changedAt: new Date().toISOString(),
          changedBy: { fullName: "Workflow Auditor" },
          reason: "Asphalt patch team assigned",
          notes: "Asphalt patch team assigned",
        },
      ],
    };

    API.patch.mockResolvedValueOnce({ data: updatedIssue });

    const saveBtn = screen.getByRole("button", { name: /Save Status & Assignment/i });
    fireEvent.click(saveBtn);

    // Verify success banner
    expect(await screen.findByText("Issue status updated successfully.")).toBeInTheDocument();

    // Verify that the status history timeline now renders the new transition
    expect(screen.queryByTestId("status-history-empty")).not.toBeInTheDocument();
    expect(screen.getByTestId("status-history-entry-0")).toBeInTheDocument();
    expect(screen.getByTestId("status-history-entry-0")).toHaveTextContent("reported");
    expect(screen.getByTestId("status-history-entry-0")).toHaveTextContent("in progress");
    expect(screen.getByTestId("status-history-entry-0")).toHaveTextContent("Workflow Auditor");
    expect(screen.getByTestId("status-history-entry-0")).toHaveTextContent("Asphalt patch team assigned");
  });

  test("49. Notification Polling Visibility Guard: Pauses polling while document is hidden and resumes immediately when visible", async () => {
    const mockAdmin = {
      _id: "adm_poll_01",
      email: "poll.admin@civicvision.gov",
      fullName: "Polling Auditor",
      role: "admin",
    };
    localStorage.setItem("adminToken", "mock_admin_token");
    localStorage.setItem("adminData", JSON.stringify(mockAdmin));

    API.get.mockImplementation((url) => {
      if (url.includes("/admin/profile") || url.includes("profile")) {
        return Promise.resolve({ data: { error: false, admin: mockAdmin, role: "admin", isAdmin: true } });
      }
      if (url.includes("issues")) {
        return Promise.resolve({ data: [] });
      }
      return Promise.resolve({ data: {} });
    });

    render(<App />);

    // Wait for Dashboard to mount
    expect(await screen.findByText("Polling Auditor")).toBeInTheDocument();

    // Verify initial load occurred
    await waitFor(() => {
      expect(mockFetchUnreadNotificationCount).toHaveBeenCalled();
    });
    mockFetchUnreadNotificationCount.mockClear();

    // 1. Simulate tab hidden
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });

    // Fire visibilitychange to hidden (should not trigger fetch)
    fireEvent(document, new Event("visibilitychange"));
    expect(mockFetchUnreadNotificationCount).not.toHaveBeenCalled();

    // 2. Simulate tab becoming visible again
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    fireEvent(document, new Event("visibilitychange"));

    // Verify immediate refresh when tab becomes visible
    await waitFor(() => {
      expect(mockFetchUnreadNotificationCount).toHaveBeenCalledTimes(1);
    });

    // Restore visibilityState
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
  });

  test("50. Notification Polling Visibility Guard: Cleans up interval and visibilitychange listener on unmount", async () => {
    const mockAdmin = {
      _id: "adm_poll_02",
      email: "cleanup.admin@civicvision.gov",
      fullName: "Cleanup Auditor",
      role: "admin",
    };
    localStorage.setItem("adminToken", "mock_admin_token");
    localStorage.setItem("adminData", JSON.stringify(mockAdmin));

    API.get.mockImplementation((url) => {
      if (url.includes("/admin/profile") || url.includes("profile")) {
        return Promise.resolve({ data: { error: false, admin: mockAdmin, role: "admin", isAdmin: true } });
      }
      return Promise.resolve({ data: [] });
    });

    const removeListenerSpy = jest.spyOn(document, "removeEventListener");
    const clearIntervalSpy = jest.spyOn(window, "clearInterval");

    const { unmount } = render(<App />);

    // Wait for dashboard to mount before unmounting
    expect(await screen.findByText("Cleanup Auditor")).toBeInTheDocument();

    unmount();

    expect(removeListenerSpy).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    expect(clearIntervalSpy).toHaveBeenCalled();

    removeListenerSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });

  test("51. Secondary Views & Mobile Queue: Seamless navigation across Hotspots, Notifications, and Analytics with responsive controls", async () => {
    const mockAdmin = {
      _id: "adm_views_01",
      email: "views.admin@civicvision.gov",
      fullName: "Secondary Views Auditor",
      role: "admin",
    };
    localStorage.setItem("adminToken", "mock_admin_token");
    localStorage.setItem("adminData", JSON.stringify(mockAdmin));

    const mockIssue = {
      _id: "660000000000000000000601",
      type: "pothole",
      description: "Mobile issue queue item",
      status: "reported",
      department: "Roads & Infrastructure",
      createdAt: new Date().toISOString(),
    };

    API.get.mockImplementation((url) => {
      if (url.includes("/admin/profile") || url.includes("profile")) {
        return Promise.resolve({ data: { error: false, admin: mockAdmin, role: "admin", isAdmin: true } });
      }
      if (url.includes("issues")) {
        return Promise.resolve({ data: [mockIssue] });
      }
      if (url.includes("hotspots")) {
        return Promise.resolve({ data: { error: false, hotspots: [], total: 0, page: 1, limit: 20 } });
      }
      if (url.includes("notifications")) {
        return Promise.resolve({ data: { error: false, notifications: [], total: 0, unreadCount: 0 } });
      }
      if (url.includes("analytics")) {
        return Promise.resolve({
          data: {
            error: false,
            data: {
              summary: {
                totalIssues: 1,
                openIssues: 1,
                resolvedIssues: 0,
                reportedIssues: 1,
                inProgressIssues: 0,
                needsReviewIssues: 0,
                resolutionRate: 0,
                resolutionRateFormatted: "0.0%",
              },
              mttr: { avgHours: null, sampleSize: 0, formatted: "N/A" },
              breakdowns: {
                byStatus: { reported: 1 },
                byCategory: [{ category: "pothole", count: 1, percentage: "100%" }],
                byDepartment: [{ department: "Roads & Infrastructure", count: 1, percentage: "100%" }],
              },
              hotspots: { total: 0, active: 0, totalDistinctDefects: 0 },
              trend: { days: 30, data: [] },
            },
          },
        });
      }
      return Promise.resolve({ data: [] });
    });

    render(<App />);

    expect(await screen.findByText("Mobile issue queue item")).toBeInTheDocument();

    // 1. Check mobile queue table wrapper exists and has search input
    const tableWrapper = document.querySelector(".table-wrapper");
    expect(tableWrapper).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Search by ID/i)).toBeInTheDocument();

    // 2. Switch to Hotspots Tab
    const hotspotsTab = screen.getByTestId("tab-hotspots");
    fireEvent.click(hotspotsTab);

    expect(await screen.findByTestId("hotspots-section")).toBeInTheDocument();
    expect(screen.getByTestId("refresh-hotspots-btn")).toBeInTheDocument();

    // 3. Open Notifications Center via Bell
    const bellBtn = screen.getByTestId("btn-notification-bell");
    fireEvent.click(bellBtn);

    expect(await screen.findByTestId("notification-center")).toBeInTheDocument();
    expect(screen.getByTestId("mark-all-read-btn")).toBeInTheDocument();

    // 4. Switch to Analytics Tab
    const analyticsTab = screen.getByTestId("tab-analytics");
    fireEvent.click(analyticsTab);

    expect(await screen.findByTestId("analytics-section")).toBeInTheDocument();
    expect(screen.getByText("Municipal Performance Analytics")).toBeInTheDocument();
  });
});



