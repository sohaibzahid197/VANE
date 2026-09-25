// Fires the refresh pipeline on a schedule that actually happens.
//
// The workflow asks GitHub for a run every fifteen minutes. Measured over
// thirty-one hours, GitHub delivered 14 of the 124 it was asked for — an 88.7%
// drop rate, a median gap of 109 minutes and a worst observed gap of four and
// a third hours. GitHub documents this: scheduled events are delayed under
// load and "some queued jobs may be dropped".
//
// The damage is not the stale label on the Signals screen. The refresh run is
// also what GRADES predictions: resolve.ts and scorecard.ts settle a call
// using whichever run fires after it comes due, at that run's prices. With a
// median 82-minute lag, a 24-hour call is being settled against a market
// hours away from its horizon — an 18% timing error on the horizon it claims
// to measure. The published hit rate is the one number this product asks to
// be trusted on, and a dropped trigger was quietly corrupting it.
//
// So: Cloudflare keeps the clock, GitHub keeps doing the work. Nothing in the
// pipeline changes. The workflow's own `schedule:` entries stay as a backstop,
// and its `concurrency` group already coalesces an overlap, so a double fire
// costs nothing.
//
// This lives apart from vane-entitlement deliberately. That Worker decides who
// has paid; it holds the Apple signing key and the Firebase service account,
// and its deploy script rewrites the app's validator URL. A repository token
// does not belong beside those, and a change to the cron should not redeploy
// the payment path.

export type Env = {
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_WORKFLOW: string;
  GITHUB_REF: string;
  GITHUB_TOKEN: string;
};

async function dispatch(env: Env): Promise<{ ok: boolean; status: number; detail: string }> {
  const url =
    `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}` +
    `/actions/workflows/${env.GITHUB_WORKFLOW}/dispatches`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      // Not optional. api.github.com rejects a request without one with 403,
      // which would look exactly like a bad token.
      'User-Agent': 'vane-cron',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: env.GITHUB_REF }),
  });

  // Success is 204 with an empty body. There is no run id in the response, so
  // this can confirm the request was accepted and nothing more — a working
  // dispatcher and a broken pipeline look identical from here. Verify the run
  // history separately.
  const detail = res.ok ? '' : (await res.text().catch(() => '')).slice(0, 300);
  return { ok: res.ok, status: res.status, detail };
}

export default {
  /**
   * The scheduled handler.
   *
   * Cloudflare does not retry a tick that throws, so failures are logged and
   * swallowed rather than allowed to propagate — a thrown handler loses the
   * tick either way, and the log is the only thing that survives to explain
   * why. GitHub's own schedules remain as the fallback.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const r = await dispatch(env);
          if (r.ok) {
            console.log(`dispatched ${env.GITHUB_WORKFLOW} (${r.status})`);
            return;
          }
          // 403 and 404 are the two that matter and they are easy to confuse.
          // A workflow auto-disabled after sixty days of inactivity cannot be
          // dispatched either, and answers 403 — the same as an expired or
          // under-scoped token.
          console.error(
            `dispatch failed ${r.status}: ${r.detail}` +
              (r.status === 403 || r.status === 404
                ? ' — check the token has not expired, and that the workflow is enabled'
                : ''),
          );
        } catch (e) {
          console.error('dispatch threw', e);
        }
      })(),
    );
  },

  /**
   * A manual trigger, so the thing can be tested without waiting for a tick.
   *
   * Unauthenticated on purpose: it starts a public repository's public
   * workflow and returns nothing. The worst an abuser achieves is refreshing
   * prices, which the workflow's concurrency group already coalesces.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== '/run') {
      return new Response('vane-cron', { status: 200 });
    }
    const r = await dispatch(env);
    return new Response(JSON.stringify(r), {
      status: r.ok ? 200 : 502,
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
