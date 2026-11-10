// GitHub OAuth device flow, shared by the popup and the service worker.
//
// The in-progress flow lives in chrome.storage.session. The popup starts it
// directly (no messaging needed) and polls while it's open. The service worker
// sees the storage change and keeps polling after the popup closes, which
// happens as soon as the user switches to the GitHub tab. Polls are throttled
// through `lastPollAt`, so two pollers don't exceed GitHub's interval.

const Auth = (() => {
  const DEVICE_CODE_URL = "https://github.com/login/device/code";
  const TOKEN_URL = "https://github.com/login/oauth/access_token";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let polling = false;

  async function postForm(url, params) {
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(params),
      });
    } catch {
      throw new Error(
        "Couldn't reach github.com. If an ad or privacy blocker is installed, allow github.com/login. Otherwise, remove this extension and load it again."
      );
    }
    let json = {};
    try {
      json = await res.json();
    } catch {}
    if (!res.ok && !json.error) throw new Error(`GitHub returned ${res.status}`);
    return json;
  }

  async function getFlow() {
    const { authFlow = null } = await chrome.storage.session.get("authFlow");
    return authFlow;
  }
  async function setFlow(flow) {
    if (flow) await chrome.storage.session.set({ authFlow: flow });
    else await chrome.storage.session.remove("authFlow");
  }

  async function getClientId() {
    if (typeof GITHUB_CLIENT_ID !== "undefined" && GITHUB_CLIENT_ID) return GITHUB_CLIENT_ID;
    const { clientId = "" } = await chrome.storage.local.get("clientId");
    return clientId;
  }

  async function start() {
    const clientId = await getClientId();
    if (!clientId) throw new Error("No GitHub OAuth Client ID configured.");
    const r = await postForm(DEVICE_CODE_URL, { client_id: clientId, scope: GITHUB_SCOPES });
    if (r.error) {
      if (r.error === "device_flow_disabled") throw new Error("Device Flow isn't enabled on your OAuth App. Tick “Enable Device Flow” in the app settings.");
      if (r.error === "Not Found") throw new Error("GitHub didn't recognize that Client ID. Check it on your OAuth App page.");
      throw new Error(r.error_description || r.error);
    }
    const flow = {
      status: "pending",
      clientId,
      userCode: r.user_code,
      verificationUri: r.verification_uri,
      deviceCode: r.device_code,
      interval: r.interval || 5,
      expiresAt: Date.now() + (r.expires_in || 900) * 1000,
      lastPollAt: 0,
    };
    await setFlow(flow);
    return flow;
  }

  async function fail(flow, error) {
    await setFlow({ status: "error", error, userCode: flow.userCode });
  }

  // Polls until the flow finishes, fails, or is cancelled. Safe to call repeatedly.
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      while (true) {
        let flow = await getFlow();
        if (!flow || flow.status !== "pending") return;
        if (Date.now() > flow.expiresAt) return fail(flow, "The code expired. Try signing in again.");

        const wait = flow.lastPollAt + flow.interval * 1000 - Date.now();
        await sleep(Math.max(wait, 1000));

        // Re-read: the user may have cancelled, or another poller just polled.
        // (The storage call also keeps the service worker alive between polls.)
        flow = await getFlow();
        if (!flow || flow.status !== "pending") return;
        if (Date.now() - flow.lastPollAt < flow.interval * 1000 - 250) continue;
        await setFlow({ ...flow, lastPollAt: Date.now() });

        let r;
        try {
          r = await postForm(TOKEN_URL, {
            client_id: flow.clientId,
            device_code: flow.deviceCode,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          });
        } catch {
          continue; // transient network error
        }

        if (r.access_token) {
          await completeSignIn(r.access_token);
          await setFlow(null);
          return;
        }
        switch (r.error) {
          case "authorization_pending":
            break;
          case "slow_down":
            await setFlow({ ...(await getFlow()), interval: r.interval || flow.interval + 5 });
            break;
          case "expired_token":
            return fail(flow, "The code expired. Try signing in again.");
          case "access_denied":
            return fail(flow, "Sign-in was cancelled on GitHub.");
          case "incorrect_device_code":
            return; // flow was replaced or already finished elsewhere
          default:
            return fail(flow, r.error_description || r.error || "Sign-in failed.");
        }
      }
    } finally {
      polling = false;
    }
  }

  async function completeSignIn(token) {
    let user = null;
    try {
      const res = await fetch("https://api.github.com/user", {
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const u = await res.json();
        user = { login: u.login, avatarUrl: u.avatar_url };
      }
    } catch {}
    await chrome.storage.local.remove(["cache:mine", "cache:contrib"]);
    await chrome.storage.local.set({ token, user, authMethod: "oauth" });
  }

  return { start, poll, getFlow, setFlow };
})();
