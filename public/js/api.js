/**
 * API fetch wrapper with CSRF token injection and error handling.
 */
const API = {
    basePath: '',
    csrfToken: '',

    init(config) {
        this.basePath = config.basePath || '';
        this.csrfToken = config.csrfToken || '';
    },

    setCsrfToken(token) {
        this.csrfToken = token;
    },

    async request(method, path, body) {
        const url = this.basePath + '/api/' + path;
        const headers = { 'Accept': 'application/json' };

        if (this.csrfToken && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
            headers['X-CSRF-Token'] = this.csrfToken;
        }
        if (body !== undefined && body !== null) {
            headers['Content-Type'] = 'application/json';
        }

        const opts = {
            method: method,
            headers: headers,
            credentials: 'same-origin'
        };
        if (body !== undefined && body !== null) {
            opts.body = JSON.stringify(body);
        }

        const response = await fetch(url, opts);

        let data = null;
        const text = await response.text();
        if (text) {
            try { data = JSON.parse(text); } catch (e) { data = null; }
        }

        if (response.status === 401) {
            // Don't redirect if we're already on the login page (this is a login attempt)
            const isLoginRequest = path === 'auth/login';
            if (!isLoginRequest) {
                App.currentUser = null;
                window.location.hash = '#/login';
            }
            const msg = (data && data.error) ? data.error : 'Session expired. Please log in again.';
            throw new ApiError(401, msg, data && data.field);
        }

        if (!response.ok) {
            const msg = (data && data.error) ? data.error : 'Request failed (HTTP ' + response.status + ')';
            throw new ApiError(response.status, msg, data && data.field);
        }

        return data;
    },

    get(path) { return this.request('GET', path); },
    post(path, body) { return this.request('POST', path, body); },
    put(path, body) { return this.request('PUT', path, body); },
    del(path) { return this.request('DELETE', path); }
};

class ApiError extends Error {
    constructor(status, message, field) {
        super(message);
        this.status = status;
        this.field = field || null;
    }
}
