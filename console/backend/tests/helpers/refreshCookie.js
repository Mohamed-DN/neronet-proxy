/**
 * The refresh token a response set as its HttpOnly cookie. The control plane no
 * longer puts it in the response body, so the suites read it the way a browser
 * would receive it.
 */
function refreshCookie(res) {
  const cookies = res.headers['set-cookie'] || [];
  const cookie = cookies.find((c) => c.startsWith('refreshToken='));
  if (!cookie) return null;
  return decodeURIComponent(cookie.split(';')[0].slice('refreshToken='.length));
}

module.exports = { refreshCookie };
