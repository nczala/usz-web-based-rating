import { request } from "./http";

const ADMIN_SESSION_STORAGE_KEY = "admin-session-token";

function getAdminSessionHeaders() {
    const sessionToken = window.sessionStorage.getItem(ADMIN_SESSION_STORAGE_KEY);

    return sessionToken
        ? {
              "x-admin-session": sessionToken,
          }
        : {};
}

export function getAdminSession() {
    return request("/admin/session", {
        headers: getAdminSessionHeaders(),
    });
}

export async function loginAdmin(password) {
    const response = await request("/admin/session", {
        method: "POST",
        body: JSON.stringify({ password }),
    });

    if (response?.sessionToken) {
        window.sessionStorage.setItem(
            ADMIN_SESSION_STORAGE_KEY,
            response.sessionToken
        );
    }

    return response;
}

export async function logoutAdmin() {
    const response = await request("/admin/session", {
        method: "DELETE",
        headers: getAdminSessionHeaders(),
    });

    window.sessionStorage.removeItem(ADMIN_SESSION_STORAGE_KEY);

    return response;
}

export function getAdminAuthHeaders() {
    return getAdminSessionHeaders();
}
