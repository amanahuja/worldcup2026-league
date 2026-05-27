/**
 * github.js — shared GitHub Contents API helpers
 *
 * Uses TextDecoder/TextEncoder for correct UTF-8 handling (handles non-ASCII
 * team names like Curaçao, Côte d'Ivoire, etc.)
 */

export function githubHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'worldcup2026-league-worker',
  };
}

/** Decode base64 content from GitHub API with full UTF-8 support */
function b64Decode(b64) {
  const binary = atob(b64.replace(/\n/g, ''));
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

/** Encode content to base64 for GitHub API with full UTF-8 support */
function b64Encode(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export async function githubGet(path, env) {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}?ref=${env.GITHUB_BRANCH}`;
  const res = await fetch(url, { headers: githubHeaders(env.GITHUB_TOKEN) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${path} failed: ${res.status}`);
  const json = await res.json();
  return { content: b64Decode(json.content), sha: json.sha };
}

const APP_AUTHOR = {
  name:  'WC2026 Fantasy App',
  email: 'noreply@worldcup.amanahuja.me',
};

export async function githubPut(path, content, sha, env, message) {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`;
  const body = {
    message: message || `wc2026[app]: update ${path}`,
    content: b64Encode(content),
    branch: env.GITHUB_BRANCH,
    author:    APP_AUTHOR,
    committer: APP_AUTHOR,
    ...(sha ? { sha } : {}),
  };
  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...githubHeaders(env.GITHUB_TOKEN), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub PUT ${path} failed: ${res.status} ${err}`);
  }
  return res.json();
}

export async function listDirectory(path, env) {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}?ref=${env.GITHUB_BRANCH}`;
  const res = await fetch(url, { headers: githubHeaders(env.GITHUB_TOKEN) });
  if (!res.ok) return [];
  const items = await res.json();
  return items.filter(i => i.type === 'file').map(i => i.name);
}
