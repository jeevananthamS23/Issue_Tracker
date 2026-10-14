import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import API, { AdminAuth } from "../api/api";

const AdminAuthContext = createContext(null);

export const AdminAuthProvider = ({ children }) => {
  const [admin, setAdmin] = useState(AdminAuth.getStoredProfile());
  const [token, setToken] = useState(AdminAuth.getToken());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Restore session via GET /api/admin/profile on initial mount
  const restoreSession = useCallback(async () => {
    const existingToken = AdminAuth.getToken();
    if (!existingToken) {
      setLoading(false);
      return;
    }

    try {
      const response = await API.get("/admin/profile", {
        headers: {
          Authorization: `Bearer ${existingToken}`,
        },
      });

      // Verify that the response explicitly confirms role === "admin" and isAdmin === true
      if (response.data && response.data.role === "admin" && response.data.isAdmin) {
        const verifiedAdmin = response.data.admin;
        setAdmin(verifiedAdmin);
        setToken(existingToken);
        AdminAuth.setSession(existingToken, verifiedAdmin);
      } else {
        // Incompatible or non-admin role returned
        AdminAuth.clearSession();
        setAdmin(null);
        setToken(null);
      }
    } catch (err) {
      // 401 Unauthorized, 403 Forbidden (e.g., citizen token used), or token expired
      AdminAuth.clearSession();
      setAdmin(null);
      setToken(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    restoreSession();
  }, [restoreSession]);

  const login = async (email, password) => {
    setError(null);
    try {
      const response = await API.post("/admin/login", { email, password });
      const { accessToken, admin: adminData } = response.data;

      if (!accessToken || !adminData) {
        throw new Error("Invalid response format from login endpoint");
      }

      AdminAuth.setSession(accessToken, adminData);
      setToken(accessToken);
      setAdmin(adminData);
      return { success: true };
    } catch (err) {
      const msg =
        err.response?.data?.message ||
        (err.response?.status === 401 ? "Invalid email or password" : "Login failed. Please try again.");
      setError(msg);
      return { success: false, error: msg };
    }
  };

  const logout = () => {
    AdminAuth.clearSession();
    setToken(null);
    setAdmin(null);
    setError(null);
  };

  const value = {
    admin,
    token,
    isAuthenticated: !!token && !!admin,
    loading,
    error,
    login,
    logout,
    restoreSession,
  };

  return <AdminAuthContext.Provider value={value}>{children}</AdminAuthContext.Provider>;
};

export const useAdminAuth = () => {
  const context = useContext(AdminAuthContext);
  if (!context) {
    throw new Error("useAdminAuth must be used within an AdminAuthProvider");
  }
  return context;
};
