import { request } from "./http";

export function getUserState(userID) {
    return request(`/users/${userID}`);
}

export function getUserQuestions(userID) {
    return request(`/users/${userID}/questions`);
}

export function getUsers() {
    return request("/users");
}

export function getUserGroups() {
    return request("/user-groups");
}

export function getUserByName(username) {
    return request(`/users/by-name/${encodeURIComponent(username)}`);
}

export function createUser(payload) {
    return request("/users", {
        method: "POST",
        body: JSON.stringify(payload),
    });
}

export function deleteUser(userID) {
    return request(`/users/${encodeURIComponent(userID)}`, {
        method: "DELETE",
    });
}
