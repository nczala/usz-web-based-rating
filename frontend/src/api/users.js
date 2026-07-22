import { request } from "./http";
import { getAdminAuthHeaders } from "./admin";

export function getUserState(userID) {
    return request(`/users/${userID}`);
}

export function getUserQuestions(userID) {
    return request(`/users/${userID}/questions`);
}

export function getUsers() {
    return request("/users", {
        headers: getAdminAuthHeaders(),
    });
}

export function getUserGroups() {
    return request("/user-groups", {
        headers: getAdminAuthHeaders(),
    });
}

export function getUserByName(username) {
    return request(`/users/by-name/${encodeURIComponent(username)}`);
}

export function createUser(payload) {
    return request("/users", {
        method: "POST",
        headers: getAdminAuthHeaders(),
        body: JSON.stringify(payload),
    });
}

export function deleteUser(userID) {
    return request(`/users/${encodeURIComponent(userID)}`, {
        method: "DELETE",
        headers: getAdminAuthHeaders(),
    });
}
