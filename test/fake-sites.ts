import http from 'node:http';
import type { AddressInfo } from 'node:net';

export const USERNAME = 'agent@example.test';
export const PASSWORD = 'pw-Zq8!kT2#vL5^mX9 &=+';

// Every value typed into any input on the page is posted back here, so a test can
// prove a password never reached a field or a site it should not have.
const RECORD_TYPING = `<script>
  for (const input of document.querySelectorAll('input')) {
    input.addEventListener('input', () => fetch('/typed', { method: 'POST', body: input.value }));
  }
</script>`;

const LOGIN_FORM = `<!doctype html><title>Sign in</title>
<form method="post" action="/login">
  <input id="email" name="email" type="text">
  <input id="note" name="note" type="text">
  <input id="password" name="password" type="password">
  <button id="submit" type="submit">Sign in</button>
</form>${RECORD_TYPING}`;

// Draws the login form a second after the page loads, like a single-page app.
const SLOW_LOGIN_FORM = `<!doctype html><title>Sign in</title><div id="app"></div>
<script>setTimeout(() => { document.getElementById('app').innerHTML = ${JSON.stringify(LOGIN_FORM).replaceAll("</", "<\\/")}; }, 1000);</script>`;

export type FakeSite = {
  origin: string;
  received: string[];
  loginAttempts: number;
  // Set after start when the target needs this site's own port.
  redirectAfterLogin?: string;
  close: () => Promise<void>;
};

type Routes = { redirectLoginTo?: string; slowFormAfterFailedLogin?: boolean };

export async function startFakeSite(routes: Routes = {}): Promise<FakeSite> {
  const site: FakeSite = { origin: '', received: [], loginAttempts: 0, close: async () => {} };
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    site.received.push(`${req.method} ${req.url} ${body}`);
    const url = new URL(req.url ?? '/', site.origin);

    if (url.pathname === '/login' && req.method === 'GET') {
      if (routes.redirectLoginTo) return redirect(res, routes.redirectLoginTo);
      return html(res, LOGIN_FORM);
    }
    if (url.pathname === '/login' && req.method === 'POST') {
      site.loginAttempts += 1;
      if (site.redirectAfterLogin) return redirect(res, site.redirectAfterLogin);
      const form = new URLSearchParams(body);
      if (form.get('email') === USERNAME && form.get('password') === PASSWORD) {
        res.setHeader('Set-Cookie', 'session=signed-in-token; HttpOnly; Path=/');
        return redirect(res, `/home?username=${USERNAME}`);
      }
      if (routes.slowFormAfterFailedLogin) return html(res, SLOW_LOGIN_FORM);
      return html(res, `<p id="error">Wrong email or password</p>${LOGIN_FORM}`);
    }
    if (url.pathname === '/booking') return html(res, '<title>Booking</title><h1>Bookings</h1>');
    if (url.pathname === '/home') {
      const signedIn = /session=signed-in-token/.test(req.headers.cookie ?? '');
      return html(res, signedIn ? '<title>Home</title><h1 id="welcome">Signed in</h1>' : '<title>Home</title><h1>Signed out</h1>');
    }
    res.statusCode = 204;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  site.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  site.close = () => new Promise((resolve) => server.close(() => resolve()));
  return site;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
  });
}

function html(res: http.ServerResponse, content: string): void {
  res.setHeader('content-type', 'text/html');
  res.end(content);
}

function redirect(res: http.ServerResponse, location: string): void {
  res.statusCode = 302;
  res.setHeader('location', location);
  res.end();
}

export function sawPassword(site: FakeSite): boolean {
  const forms = [PASSWORD, encodeURIComponent(PASSWORD), new URLSearchParams({ p: PASSWORD }).toString().slice(2)];
  return site.received.some((entry) => forms.some((form) => entry.includes(form)));
}
