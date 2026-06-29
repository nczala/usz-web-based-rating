import { request } from "./http";

export function getRating(userId, orderId) {
    return request(`/ratings/${userId}/${orderId}`);
}

export function saveRating(userId, orderID, payload) {
    return request(`/ratings/${userId}/${orderID}`, {
        method: "POST",
        body: JSON.stringify(payload),
    });
}
