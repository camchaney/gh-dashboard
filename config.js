// Client ID of your GitHub OAuth App (not a secret; safe to commit).
// Create one at https://github.com/settings/applications/new
//   - Homepage URL / Authorization callback URL: anything, e.g. https://github.com
//   - After creating it, tick "Enable Device Flow" and save.
// Then paste the app's Client ID below and reload the extension.
const GITHUB_CLIENT_ID = "";

// "repo" is needed to list private repos. GitHub has no read-only private-repo scope.
// "read:org" lets org repos show up under "My repos".
const GITHUB_SCOPES = "repo read:org";
