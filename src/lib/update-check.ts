/** Stable GitHub Releases discovery; installation is independently verified by the native updater. */
import { getHttpFetch, isFetchNetworkError } from "./tauri-fetch"

/** The subset of the GitHub release API response we care about. */
/**
 * Map any GitHub release-related URL to that repo's
 * `/releases/latest` form. Two reasons we prefer the canonical
 * `/latest` URL over the API-returned `html_url`:
 *
 *   - `html_url` for a release object is `/releases/tag/<tag>`
 *     (tag-specific). If a newer release ships between when we
 *     notified the user and when they click, sending them to the
 *     tag page gives them a stale view; `/releases/latest` always
 *     follows GitHub's redirect to whatever is genuinely latest.
 *
 *   - The bare `/releases` listing URL (sometimes used as a stub)
 *     shows a paginated list whose default sort isn't strictly
 *     "newest first" once a repo has many releases — the user
 *     might land on the page and not see the new version above
 *     the fold.
 *
 * Idempotent: passing an already-`/latest` URL returns it
 * unchanged. Falls through with the original URL when the input
 * doesn't look like a github.com release link (don't break random
 * external URLs).
 */
export function toLatestReleaseUrl(htmlUrl: string): string {
  const m = htmlUrl.match(/^(https?:\/\/github\.com\/[^/]+\/[^/]+)\/releases(?:\/.*)?$/i)
  if (!m) return htmlUrl
  return `${m[1]}/releases/latest`
}

export interface GithubRelease {
  tag_name: string          // e.g. "v0.3.10"
  name: string              // display title
  body: string              // markdown release notes
  html_url: string          // browser URL for the release page
  published_at: string      // ISO timestamp
}

export type UpdateStatus =
  | { kind: "available"; local: string; remote: string; release: GithubRelease }
  | { kind: "up-to-date"; local: string; remote: string }
  | { kind: "error"; local: string; message: string }

/**
 * Strict semver-ish comparison of two "MAJOR.MINOR.PATCH" strings.
 * We don't use pre-release tags or build metadata in this project, so
 * a plain three-component numeric compare is enough and avoids pulling
 * in the `semver` npm package just for this.
 *
 * Returns true iff `remote` is strictly greater than `local`. A leading
 * `v` on either side is tolerated; anything non-numeric in a slot
 * is rejected on remote tags (so malformed releases cannot trigger an upgrade).
 */
export function isNewer(remote: string, local: string): boolean {
  const parse = (s: string): number[] | null => {
    const clean = s.replace(/^v/i, "")
    if (!/^\d+(?:\.\d+){0,2}$/.test(clean)) return null
    const parts = clean.split(".").map(Number)
    if (parts.some(n => !Number.isSafeInteger(n))) return null
    return [parts[0], parts[1] ?? 0, parts[2] ?? 0]
  }
  const r = parse(remote), l = parse(local) ?? [0, 0, 0]
  if (!r) return false
  for (let i = 0; i < 3; i++) if (r[i] !== l[i]) return r[i] > l[i]
  return false
}

/**
 * Fetch the latest release from a GitHub repo. Returns null on any
 * failure (network / rate-limit / 404 when no release exists yet).
 * Doesn't throw — the caller's job is to render the failure as an
 * "error" status, not to log it or alert the user.
 *
 * Routes through the Tauri HTTP plugin so it stays consistent with the
 * rest of the app's third-party traffic and doesn't depend on the
 * webview's CORS policy for api.github.com (which is permissive today
 * but might not always be).
 */
export async function fetchLatestRelease(
  repo: string,
): Promise<GithubRelease | null> {
  const url = `https://api.github.com/repos/${repo}/releases/latest`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20_000)
  try {
    const httpFetch = await getHttpFetch()
    const resp = await httpFetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    })
    if (!resp.ok) return null
    const data = await resp.json()
    if (data?.draft === true || data?.prerelease === true) return null
    // Duck-type the response shape — GitHub occasionally adds fields
    // but the ones below have been stable since the API's v3 days.
    if (
      typeof data?.tag_name === "string" &&
      /^v?\d+(?:\.\d+){0,2}$/i.test(data.tag_name) &&
      typeof data?.html_url === "string" &&
      data.html_url.startsWith(`https://github.com/${repo}/releases/`)
    ) {
      return {
        tag_name: data.tag_name,
        name: typeof data.name === "string" ? data.name : data.tag_name,
        body: typeof data.body === "string" ? data.body : "",
        html_url: data.html_url,
        published_at:
          typeof data.published_at === "string" ? data.published_at : "",
      }
    }
    return null
  } catch (err) {
    if (isFetchNetworkError(err)) return null
    return null
  } finally { clearTimeout(timeout) }
}

/**
 * End-to-end check: fetch + compare + package into a renderable
 * status. Callers pass in `currentVersion` from the build-time define
 * and `repo` from the project config — the module itself stays free
 * of environment coupling so it's easy to unit-test.
 */
export async function checkForUpdates(opts: {
  currentVersion: string
  repo: string
}): Promise<UpdateStatus> {
  const { currentVersion, repo } = opts
  const release = await fetchLatestRelease(repo)
  if (!release) {
    return {
      kind: "error",
      local: currentVersion,
      message: "Could not reach GitHub Releases API.",
    }
  }
  const remote = release.tag_name
  if (isNewer(remote, currentVersion)) {
    return {
      kind: "available",
      local: currentVersion,
      remote,
      release,
    }
  }
  return { kind: "up-to-date", local: currentVersion, remote }
}

/** Legacy exported constant. The application now schedules daily slots in update-runtime. */
// 1 hour cache between background checks. Originally 6h, shortened
// because users were going long stretches without learning about
// new releases. GitHub's anonymous /releases/latest endpoint allows
// 60 req/hour from the same IP, so even a user opening / closing
// the app dozens of times in an hour stays well under the limit
// (the cache itself prevents back-to-back hits within the window).
export const UPDATE_CHECK_CACHE_MS = 60 * 60 * 1000 // 1 hour

export const UPDATE_REPOSITORY = "superrepus/WIKI"
export const UPDATE_RELEASES_URL = "https://github.com/superrepus/WIKI/releases/latest"
