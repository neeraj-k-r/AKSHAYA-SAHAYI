// Single place for the backend URL.
// Set VITE_API_URL in the hosting env to override (e.g. local dev).
// Defaults to the live Render backend.
export const API_BASE =
    import.meta.env.VITE_API_URL || 'https://akshaya-sahayi.onrender.com';

export function authHeaders(token) {
    return {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
    };
}
