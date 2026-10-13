// Thin fetch wrapper for the /api endpoints. Throws an Error carrying the server's Arabic message.
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(path, { method = 'GET', body, form, query } = {}) {
  let url = '/api' + path;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') qs.set(k, v);
    const s = qs.toString();
    if (s) url += '?' + s;
  }
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (form) {
    opts.body = form;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw new ApiError(0, 'تعذر الاتصال بالخادم. تأكد من تشغيله');
  }
  const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
  if (res.status === 401 && path !== '/auth/login') {
    location.href = '/login.html';
    throw new ApiError(401, (data && data.error) || 'يجب تسجيل الدخول');
  }
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || 'حدث خطأ غير متوقع');
  return data;
}
