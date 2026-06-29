const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:8000";

async function fetchJson(path) {
    const response = await fetch(`${BACKEND_URL}${path}`);

    if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
    }

    return response.json();
}

export function getUserState(userID) {
    return fetchJson(`/users/${userID}`);
}

export function getUserQuestions(userID) {
    return fetchJson(`/users/${userID}/questions`);
}