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
});


