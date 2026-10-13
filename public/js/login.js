import { api } from './api.js';

const form = document.getElementById('login-form');
const errBox = document.getElementById('login-error');

// Already logged in? Go straight to the app.
fetch('/api/auth/me', { credentials: 'same-origin' }).then((r) => { if (r.ok) location.href = '/'; });

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errBox.hidden = true;
  const { username, password } = Object.fromEntries(new FormData(form).entries());
  if (!username.trim() || !password) {
    errBox.textContent = 'أدخل اسم المستخدم وكلمة المرور';
    errBox.hidden = false;
    return;
  }
  const btn = form.querySelector('button');
  btn.disabled = true;
  try {
    await api('/auth/login', { method: 'POST', body: { username, password } });
    location.href = '/';
  } catch (err) {
    errBox.textContent = err.message;
    errBox.hidden = false;
    form.password.value = '';
    form.password.focus();
  } finally {
    btn.disabled = false;
  }
});
