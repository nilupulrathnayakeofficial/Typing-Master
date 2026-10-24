# Nilupul Rathnayake Typing Master

A typing website with solo tests, live multiplayer races (up to 8 players), a leaderboard, sign in with email or Google, and an owner-only Members page showing every member's speed and IP addresses.

No `npm install` is needed. It has no dependencies and stores everything in one SQLite file (`data/typing.db`).

## Run it on your computer

1. Install Node.js 22.13 or newer from https://nodejs.org
2. Open a terminal in this folder and run:

```
npm start
```

3. Open http://localhost:3000

The owner account is created from `.env` every time the server starts:

```
OWNER_EMAIL=...
OWNER_PASSWORD=...
```

To change the owner password, edit `OWNER_PASSWORD` in `.env` and restart. Keep `.env` private. It is already excluded by `.gitignore`.

## What the owner sees

Log in with the owner email and password, then open **Members**:

- Every member, how they sign in (password or Google), best, average and last WPM, tests taken
- Signup IP and latest IP, last seen, and who is online now
- A **History** button with the last 30 logins per member (time, IP address, method, browser)
- Search by name, email or IP, **Download CSV**, and **Suspend** or **Restore** for any member

Members tick a box when they sign up to confirm the site records their IP address, login times and scores. IP addresses are personal data in many countries, so keep the Members page private and delete someone's data if they ask.

## Turn on "Continue with Google"

Google login needs a client ID that only you can create (free):

1. Go to https://console.cloud.google.com and create a project.
2. APIs and Services, then OAuth consent screen: choose External and fill in the app name and your email.
3. Credentials, then Create credentials, then OAuth client ID, then Web application.
4. Under Authorized JavaScript origins add `http://localhost:3000` and, once you have one, your public site address (it must be `https://`).
5. Copy the client ID into `.env`:

```
GOOGLE_CLIENT_ID=1234567890-abcdef.apps.googleusercontent.com
```

6. Restart the server. The Google button appears on the login page.

If the owner's Google account uses the same email as the owner login, the two are linked automatically. For everyone else, an email that already has a password account cannot be taken over by a Google sign-in.

## Put it on the internet

Players need a public address. Two options:

- **From your own computer:** run `npm start`, then use a free Cloudflare Tunnel (`cloudflared tunnel --url http://localhost:3000`) to get an `https://` link. Friends open that link. The site is only online while your computer is on.
- **On a host:** any host that runs Node 22 and gives you a persistent disk (a VPS, Railway, Fly.io, Render with a paid disk). Free tiers that wipe the disk on restart will delete your members and scores, so avoid them for this.

When the site is behind HTTPS and a proxy, set these in `.env` so cookies are secure and the Members page shows the visitor's real IP instead of the proxy's:

```
TRUST_PROXY=true
COOKIE_SECURE=true
```

Set `DATA_DIR` to the persistent disk path, and back up `typing.db` now and then.

## How the multiplayer works

- Quick race joins any open room or starts one. Create a room gives you a 5-letter code and an invite link.
- The host starts the race once 2 or more players are in. Everyone gets the same 35 words after a 3 second countdown.
- Race speed is timed by the server. Impossible speeds (over 300 WPM) or impossible progress are rejected and not saved.
- Solo test scores are measured in the browser and capped at 300 WPM, so they can be faked by a determined cheater. Race scores cannot.

## Tests

```
npm test
```

Runs 60 checks against a throwaway database: signup, login, throttling, owner-only access, suspending, Google token checks, and a full 2-player race.
