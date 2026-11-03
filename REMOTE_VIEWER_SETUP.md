# REDLINE Remote Viewer v1.0 — Setup

This is a **visible, consent-based** live camera viewer for one Android test device and one authenticated admin browser. It does not provide covert access, background surveillance, remote device control, or stored recordings.

## Architecture

- `admin.html` — public static admin **interface** on GitHub Pages. The signaling service protects live session data with a server-side password; the HTML itself is public.
- `share.html` — Android sharing page; connecting does **not** activate its camera. The user must tap **Start camera sharing** and approve the browser prompt. Leaving the page automatically stops sharing.
- `worker/` — Cloudflare Worker + Durable Object handling password verification, short-lived one-use pairing invitations and WebRTC signaling. It does **not** receive the camera stream.
- WebRTC — encrypted live camera video between consenting browser and admin, using a public STUN service for connectivity. Some restrictive networks will require a separately configured TURN relay, not provided in v1.

## Deploy without installing anything on the office PC

1. Sign into your **personal** Cloudflare account at [dash.cloudflare.com](https://dash.cloudflare.com). Do not use company credentials or change the office network.
2. Go to **Workers & Pages**, create/connect a Worker from GitHub, and select `Mubeen97/redline-qr-lab`.
3. The existing Cloudflare Worker is named `redline-qr-lab` (matching `worker/wrangler.jsonc`). Set **root directory** to `worker` under **Settings → Build → Build Configuration**.
4. Use build command `npm install` and deploy command `npx wrangler deploy`. Cloudflare performs the install/build on its own infrastructure; there is no local installation. The first deploy creates the SQLite-backed Durable Object namespace.
5. In Cloudflare Worker **Settings → Variables and Secrets**, add a **Secret** (not plaintext variable) named exactly `ADMIN_PASSWORD`. Give it a unique, random password of at least 16 characters. **Do not put the password in GitHub or send it in chat.** Deploy the secret change.
6. Note the actual HTTPS Worker URL, such as `https://redline-qr-lab.<your-subdomain>.workers.dev`. Test `<worker-url>/health` in the browser. The result should report `"status":"ready"`.

If the Worker cannot be created without a paid plan on your account, stop and ask before enabling billing. Check the Cloudflare dashboard for current plan terms and usage limits.

## Test one authorized device

1. On your personal PC open `https://mubeen97.github.io/redline-qr-lab/admin.html`.
2. Enter the **HTTPS Worker URL** and the Cloudflare `ADMIN_PASSWORD` that **you** chose; click **Connect securely**. The password is used for this login and is not saved to localStorage.
3. Click **Create pairing link**, then **Copy invitation**. Send the invite only to your own Android test phone. Alternatively, click **Open invitation tab for Edge QR code** and use Microsoft Edge's right-click **Create QR code for this page**; the phone scans that QR. The invite is single-use and expires in 10 minutes. Merely opening the sharing page does not pair or start any camera.
4. On Android, open the invite in Chrome or another supported browser. Verify the displayed signaling service URL. Tap **Connect to admin**. The camera is **still off**.
5. Tap **Start camera sharing**, approve the Android browser permission, and keep the page visible. Your PC admin panel should show the live camera.
6. Tap **Stop and disconnect camera** on the phone, or **End live view** on the admin page. Verify video stops on both devices.

If the admin PC and Android phone are behind restrictive NAT/firewalls, signaling may succeed but WebRTC video may fail. That is expected without a TURN relay. Do not change corporate firewall settings or scan corporate ports to troubleshoot. Test first on personal devices/networks.

## Security boundaries

- The phone always starts its own camera. No admin command can trigger camera permissions or start capture.
- Only one phone and one admin WebSocket are allowed in v1.
- Invite tokens are high-entropy, single-use, expire in 10 minutes, and appear in a URL **fragment** rather than the server request path.
- The admin must know the Cloudflare secret password. Five failed attempts from one source cause a temporary authentication lockout.
- The Worker exchanges only WebRTC negotiation messages. It intentionally has no video upload endpoint, recording storage or file database.
- The public STUN service learns connection-related network metadata; the Cloudflare Worker sees connection metadata and signaling. WebRTC can disclose network addresses to peers during setup.
- WebRTC peer-to-peer media is encrypted. In networks that require TURN relaying, the relay handles encrypted media transport; that is not configured in this version.
- The GitHub Pages files are public; do not commit any secrets, contact lists, company data or real recordings.
- A static HTML login **screen** alone is not authentication. This project performs authentication in the Cloudflare signaling Worker.
- This is a learning prototype, **not** a hardened production remote-support service. Use only with devices you own or have explicit permission to test.
