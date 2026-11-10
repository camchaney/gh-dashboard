# GitHub Dashboard (Chrome extension)

A toolbar popup that shows your pinned GitHub repos. Click a repo to open it in a new tab.

## Install (unpacked)

1. Go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Pin the extension to the toolbar (puzzle-piece icon → pin).

## Setup: enable "Sign in with GitHub" (one time)

Sign-in uses GitHub's OAuth device flow, so it needs no server and no client secret.
It does need an OAuth App client ID, which you register once:

1. Go to <https://github.com/settings/applications/new>.
2. Name: anything (e.g. "My GitHub Dashboard"). For Homepage URL and Authorization callback URL, `https://github.com` works for both.
3. Click **Register application**, then tick **Enable Device Flow** and **Update application**.
4. Paste the **Client ID** into the extension's account screen. It asks for it the first time.
   Or hard-code it in `config.js` (`GITHUB_CLIENT_ID = "..."`) and reload the extension.

## Signing in

1. Open the popup → **Sign in with GitHub**.
2. Click **Copy code & open GitHub**, paste the code, and approve.
3. Reopen the popup. You're signed in, and your avatar replaces the ⚙ icon.

The extension asks for the `repo` scope so private repos show up. GitHub has no read-only private-repo scope.
For org repos, the org may need to approve the app (GitHub shows a "Request" button on the approval screen).

Prefer not to register an app? Under the account screen, **Use a personal access token instead** still works.
Search works while signed out, but with a much lower rate limit.

## Usage

- **+ Add**: pick repos from **My repos**, **Contributed**, or **Search**. You can also paste `owner/repo` or any GitHub URL to pin it directly.
- **Edit**: drag to reorder (or use ↑/↓). ✕ removes a repo.

## Storage

- Pins: `chrome.storage.sync`, split into chunks to fit the per-key quota. They follow your Chrome profile.
- Token and cached repo lists (15-minute cache, ↻ to refresh): `chrome.storage.local`, on this device only.

## Files

- `manifest.json`: MV3 manifest
- `popup.html` / `popup.css` / `popup.js`: UI and state
- `github.js`: GitHub REST and GraphQL client
- `background.js`: service worker that runs the sign-in flow
- `config.js`: OAuth client ID and scopes
