// Webmail App
class Webmail {
    constructor() {
        this.currentView = 'login-view';
        this.currentEmail = null;
        this.emails = [];
        this.jwt = null;
        this.apiBase = ''; // Set after login from config or auto-detect

        this.init();
    }

    init() {
        this.apiBase = window.WEBMAIL_API_URL || '';
        this.bindEvents();
        this.showView('login-view');
        // Auto-logout after 15 min inactivity
        this.idleTimeout = null;
        ['click', 'keydown', 'scroll'].forEach(e => document.addEventListener(e, () => this.resetIdle()));
    }

    resetIdle() {
        if (!this.jwt) return;
        clearTimeout(this.idleTimeout);
        this.idleTimeout = setTimeout(() => { this.showError('Session expired due to inactivity'); this.handleLogout(); }, 15 * 60 * 1000);
    }

    // Event Binding
    bindEvents() {
        const loginForm = document.getElementById('login-form');
        if (loginForm) loginForm.addEventListener('submit', (e) => { e.preventDefault(); this.handleLogin(); });

        this.bindButton('compose-btn', () => this.showCompose());
        this.bindButton('logout-btn', () => this.handleLogout());
        this.bindButton('back-btn', () => this.showView('list-view'));
        this.bindButton('cancel-compose-btn', () => this.showView('list-view'));
        this.bindButton('reply-btn', () => this.handleReply());
        this.bindButton('forward-btn', () => this.handleForward());
        this.bindButton('refresh-btn', () => this.refreshEmails());

        const composeForm = document.getElementById('compose-form');
        if (composeForm) composeForm.addEventListener('submit', (e) => { e.preventDefault(); this.handleSend(); });

        const searchInput = document.getElementById('search');
        if (searchInput) searchInput.addEventListener('input', (e) => this.handleSearch(e.target.value));

        this.bindButton('error-close', () => this.hideError());
    }

    bindButton(id, handler) {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', handler);
    }

    // API calls
    async api(path, options = {}) {
        const headers = { 'Content-Type': 'application/json' };
        if (this.jwt) headers['Authorization'] = `Bearer ${this.jwt}`;
        const res = await fetch(`${this.apiBase}${path}`, { ...options, headers: { ...headers, ...options.headers } });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        return data;
    }

    // View Management
    showView(viewId) {
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        const target = document.getElementById(viewId);
        if (target) {
            target.classList.add('active');
            this.currentView = viewId;
            window.scrollTo(0, 0);
            if (viewId === 'list-view' && this.emails.length === 0) this.refreshEmails();
        }
    }

    // Authentication
    async handleLogin() {
        const tokenInput = document.getElementById('token');
        if (!tokenInput) return;
        const token = tokenInput.value;
        if (!token) { this.showError('Please enter an access token'); return; }

        this.showLoading();
        try {
            const data = await this.api('/auth', {
                method: 'POST',
                body: JSON.stringify({ token }),
            });
            this.jwt = data.jwt;
            this.resetIdle();
            this.hideLoading();
            this.showView('list-view');
        } catch (e) {
            this.hideLoading();
            this.showError('Invalid access token');
        }
    }

    handleLogout() {
        this.jwt = null;
        this.emails = [];
        document.getElementById('token').value = '';
        this.showView('login-view');
    }

    // Email List
    async refreshEmails() {
        this.showLoading();
        try {
            const data = await this.api('/emails');
            this.emails = data.emails || [];
            this.renderEmailList();
        } catch (e) {
            this.showError(`Failed to load emails: ${e.message}`);
        }
        this.hideLoading();
    }

    renderEmailList() {
        const list = document.getElementById('email-list');
        list.innerHTML = '';
        if (this.emails.length === 0) {
            list.innerHTML = '<p style="text-align:center;color:#888;padding:2rem">No emails found</p>';
            return;
        }
        this.emails.forEach((em, i) => {
            const item = document.createElement('div');
            item.className = 'email-item';
            item.innerHTML = `
                <div class="email-meta">
                    <span class="sender">${this.esc(em.from)}</span>
                    <span class="date">${this.formatDate(em.date)}</span>
                </div>
                <div class="email-subject">${this.esc(em.subject)}</div>
            `;
            item.addEventListener('click', () => this.showEmail(i));
            list.appendChild(item);
        });
    }

    async showEmail(index) {
        const em = this.emails[index];
        this.showLoading();
        try {
            const data = await this.api(`/emails/${encodeURIComponent(em.id)}`);
            this.currentEmail = data;
            document.getElementById('email-subject').textContent = data.subject;
            document.getElementById('email-from').textContent = data.from;
            document.getElementById('email-to').textContent = data.to;
            document.getElementById('email-date').textContent = this.formatDate(data.date);
            const body = document.getElementById('email-body');
            if (data.html) {
                body.innerHTML = '';
                const iframe = document.createElement('iframe');
                iframe.sandbox = 'allow-same-origin';
                iframe.srcdoc = data.html;
                iframe.style.cssText = 'width:100%;border:none;min-height:400px';
                iframe.onload = () => { iframe.style.height = iframe.contentDocument.body.scrollHeight + 'px'; };
                body.appendChild(iframe);
            } else {
                body.textContent = data.text;
            }
            this.showView('read-view');
        } catch (e) {
            this.showError(`Failed to load email: ${e.message}`);
        }
        this.hideLoading();
    }

    // Compose and Send
    showCompose(replyTo = null, forward = false) {
        const form = document.getElementById('compose-form');
        if (replyTo) {
            document.getElementById('compose-to').value = replyTo.from;
            document.getElementById('compose-subject').value = forward ? `Fwd: ${replyTo.subject}` : `Re: ${replyTo.subject}`;
            const quote = replyTo.text || '';
            document.getElementById('compose-body').value = forward
                ? `\n\n--- Forwarded Message ---\nFrom: ${replyTo.from}\nSubject: ${replyTo.subject}\n\n${quote}`
                : `\n\nOn ${this.formatDate(replyTo.date)}, ${replyTo.from} wrote:\n> ${quote.replace(/\n/g, '\n> ')}`;
        } else {
            form.reset();
        }
        this.showView('compose-view');
    }

    handleReply() { if (this.currentEmail) this.showCompose(this.currentEmail, false); }
    handleForward() { if (this.currentEmail) this.showCompose(this.currentEmail, true); }

    async handleSend() {
        const to = document.getElementById('compose-to').value;
        const subject = document.getElementById('compose-subject').value;
        const body = document.getElementById('compose-body').value;
        if (!to || !subject || !body) { this.showError('Please fill in all fields'); return; }

        this.showLoading();
        try {
            await this.api('/emails', {
                method: 'POST',
                body: JSON.stringify({ to, subject, body }),
            });
            this.hideLoading();
            this.showView('list-view');
            this.showError('Email sent successfully!', 'success');
        } catch (e) {
            this.hideLoading();
            this.showError(`Failed to send: ${e.message}`);
        }
    }

    // Search (client-side filter)
    handleSearch(query) {
        document.querySelectorAll('.email-item').forEach(item => {
            item.style.display = item.textContent.toLowerCase().includes(query.toLowerCase()) ? 'block' : 'none';
        });
    }

    // UI Helpers
    showLoading() { document.getElementById('loading')?.classList.remove('hidden'); }
    hideLoading() { document.getElementById('loading')?.classList.add('hidden'); }

    showError(message, type = 'error') {
        const el = document.getElementById('error-message');
        document.getElementById('error-text').textContent = message;
        el.style.background = type === 'success' ? '#28a745' : '#dc3545';
        el.classList.remove('hidden');
        setTimeout(() => this.hideError(), 5000);
    }

    hideError() { document.getElementById('error-message')?.classList.add('hidden'); }

    esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

    formatDate(date) {
        try { return new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
        catch { return date || ''; }
    }
}

document.addEventListener('DOMContentLoaded', () => { new Webmail(); });
