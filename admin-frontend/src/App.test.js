import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import App from "./App";
import API from "./api/api";

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
  };
});

describe("Admin Frontend Application Tests", () => {
  beforeEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
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
});

