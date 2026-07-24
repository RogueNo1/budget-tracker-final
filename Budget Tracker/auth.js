// ───────────────────────────────────────────────
// Netlify Identity — handles the "accounts" side.
// Exposes window.Auth with the current user and a
// currentToken() helper used by api.js on every request.
// ───────────────────────────────────────────────
window.Auth = (function () {
  let currentUser = null;

  function renderHeader() {
    const el = document.getElementById('header-right');
    if (!el) return;
    if (currentUser) {
      el.innerHTML = `
        <span class="user-badge">${currentUser.email}</span>
        <button class="btn ghost small" id="logout-btn">Log out</button>
      `;
      document.getElementById('logout-btn').onclick = () => netlifyIdentity.logout();
    } else {
      el.innerHTML = `<button class="btn small" id="login-btn">Log in / Sign up</button>`;
      document.getElementById('login-btn').onclick = () => netlifyIdentity.open();
    }
  }

  function showLoggedIn() {
    document.getElementById('login-gate').classList.remove('visible');
    document.getElementById('app').classList.add('visible');
  }

  function showLoggedOut() {
    document.getElementById('login-gate').classList.add('visible');
    document.getElementById('app').classList.remove('visible');
  }

  function init(onLogin) {
    netlifyIdentity.on('init', user => {
      currentUser = user;
      renderHeader();
      if (user) { showLoggedIn(); onLogin && onLogin(); } else { showLoggedOut(); }
    });
    netlifyIdentity.on('login', user => {
      currentUser = user;
      renderHeader();
      showLoggedIn();
      netlifyIdentity.close();
      onLogin && onLogin();
    });
    netlifyIdentity.on('logout', () => {
      currentUser = null;
      renderHeader();
      showLoggedOut();
    });
    netlifyIdentity.init();

    document.getElementById('gate-login-btn').onclick = () => netlifyIdentity.open();
  }

  // Netlify Functions verify this token server-side (no secrets needed here).
  async function currentToken() {
    if (!currentUser) return null;
    try {
      // refresh handles expiry automatically
      return await currentUser.jwt();
    } catch (e) {
      return null;
    }
  }

  function user() { return currentUser; }

  return { init, currentToken, user };
})();
