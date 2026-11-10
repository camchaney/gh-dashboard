// Service worker: keeps a sign-in going after the popup closes.
importScripts("config.js", "auth.js");

// Storage events wake the service worker, so this fires when the popup starts a flow.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.authFlow?.newValue?.status === "pending") Auth.poll();
});

// Resume if the worker was restarted in the middle of a sign-in.
Auth.getFlow().then((flow) => flow?.status === "pending" && Auth.poll());
