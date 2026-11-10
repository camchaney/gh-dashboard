// Thin GitHub API client. All repos are normalized to the same shape so the
// UI doesn't care whether they came from REST or GraphQL.

const GH = (() => {
  const API = "https://api.github.com";

  /** @typedef {{fullName:string,url:string,description:string,language:string|null,stars:number,private:boolean,avatar:string}} Repo */

  function fromRest(r) {
    return {
      fullName: r.full_name,
      url: r.html_url,
      description: r.description || "",
      language: r.language || null,
      stars: r.stargazers_count || 0,
      private: !!r.private,
      avatar: r.owner?.avatar_url || "",
    };
  }

  function fromGraphQL(n) {
    return {
      fullName: n.nameWithOwner,
      url: n.url,
      description: n.description || "",
      language: n.primaryLanguage?.name || null,
      stars: n.stargazerCount || 0,
      private: !!n.isPrivate,
      avatar: n.owner?.avatarUrl || "",
    };
  }

  async function request(path, token, init = {}) {
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers || {}),
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(path.startsWith("http") ? path : API + path, { ...init, headers });
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try {
        const body = await res.json();
        if (body.message) msg = body.message;
      } catch {}
      if (res.status === 401) msg = "Invalid or expired token. Check Settings.";
      if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
        msg = token ? "GitHub rate limit reached. Try again shortly." : "Rate limit reached. Add a token in Settings for higher limits.";
      }
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return res;
  }

  async function getViewer(token) {
    const res = await request("/user", token);
    return res.json();
  }

  /** Repos the user owns, collaborates on, or can access through an org. */
  async function listMyRepos(token, maxPages = 5) {
    const out = [];
    for (let page = 1; page <= maxPages; page++) {
      const res = await request(
        `/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`,
        token
      );
      const batch = await res.json();
      out.push(...batch.map(fromRest));
      if (batch.length < 100) break;
    }
    return out;
  }

  /** Repos the user has contributed to (commits, PRs, issues, reviews). */
  async function listContributedRepos(token, maxPages = 3) {
    const query = `
      query($cursor: String) {
        viewer {
          repositoriesContributedTo(
            first: 100, after: $cursor, includeUserRepositories: true,
            contributionTypes: [COMMIT, PULL_REQUEST, ISSUE, PULL_REQUEST_REVIEW],
            orderBy: { field: PUSHED_AT, direction: DESC }
          ) {
            nodes {
              nameWithOwner url description isPrivate stargazerCount
              primaryLanguage { name }
              owner { avatarUrl }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`;
    const out = [];
    let cursor = null;
    for (let i = 0; i < maxPages; i++) {
      const res = await request("/graphql", token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables: { cursor } }),
      });
      const json = await res.json();
      if (json.errors?.length) throw new Error(json.errors[0].message);
      const conn = json.data.viewer.repositoriesContributedTo;
      out.push(...conn.nodes.filter(Boolean).map(fromGraphQL));
      if (!conn.pageInfo.hasNextPage) break;
      cursor = conn.pageInfo.endCursor;
    }
    return out;
  }

  async function searchRepos(q, token, signal) {
    const res = await request(
      `/search/repositories?q=${encodeURIComponent(q)}&per_page=30`,
      token,
      { signal }
    );
    const json = await res.json();
    return json.items.map(fromRest);
  }

  async function getRepo(fullName, token) {
    const res = await request(`/repos/${fullName}`, token);
    return fromRest(await res.json());
  }

  /** Accepts "owner/repo" or any github.com URL and returns "owner/repo", or null. */
  function parseRepoRef(input) {
    const s = input.trim();
    const url = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)/i);
    if (url) return `${url[1]}/${url[2].replace(/\.git$/, "")}`;
    const plain = s.match(/^([\w.-]+)\/([\w.-]+)$/);
    if (plain) return `${plain[1]}/${plain[2]}`;
    return null;
  }

  return { getViewer, listMyRepos, listContributedRepos, searchRepos, getRepo, parseRepoRef };
})();
