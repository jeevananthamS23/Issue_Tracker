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
});
