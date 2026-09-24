import { runDigest } from './server/digest.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/audio-proxy/')) {
      const filename = url.pathname.split('/audio-proxy/')[1];
      const supabaseUrl = `https://nxmodpianwotdvpixjqp.supabase.co/storage/v1/object/public/audio/${filename}`;

      const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      };

      if (request.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
      }

      // Edge-cache each audio file at Cloudflare so repeat plays/scrubs across
      // everyone are served from cache instead of re-hitting Supabase egress.
      // The Cache API slices Range requests out of a single cached full copy,
      // so seeking still works even though we never forward Range upstream.
      const cache = caches.default;
      let response = await cache.match(request);

      if (!response) {
        const originResponse = await fetch(supabaseUrl);
        if (!originResponse.ok) {
          return new Response('Upstream error', { status: originResponse.status, headers: corsHeaders });
        }
        const cacheHeaders = new Headers(originResponse.headers);
        cacheHeaders.delete('Set-Cookie'); // Supabase's Cloudflare edge sets __cf_bm; scoped to supabase.co, invalid on our domain
        cacheHeaders.set('Cache-Control', 'public, max-age=31536000, immutable');
        cacheHeaders.set('Accept-Ranges', 'bytes');
        const cacheable = new Response(originResponse.body, { status: 200, headers: cacheHeaders });
        await cache.put(request, cacheable.clone());
        response = await cache.match(request) || cacheable;
      }

      const newHeaders = new Headers(response.headers);
      Object.entries(corsHeaders).forEach(([k, v]) => newHeaders.set(k, v));

      return new Response(response.body, {
        status: response.status,
        headers: newHeaders,
      });
    }

    if (url.pathname === '/api/digest') {
      return handleDigestRequest(request, url, env);
    }

    // All other requests — serve static assets as normal
    return env.ASSETS.fetch(request);
  },

  // WhatsApp digest. Cron fires daily at 07:00 and 08:00 UTC; only the
  // run that lands on 09:00 Amsterdam time proceeds, so it follows summer/winter time.
  async scheduled(controller, env, ctx) {
    if (amsterdamHour(new Date(controller.scheduledTime)) !== 9) return;
    ctx.waitUntil(
      runDigest(env, { fromCron: true })
        .then((r) => console.log('digest', JSON.stringify(r.results.map(({ text, ...rest }) => rest))))
        .catch((e) => console.error('digest failed', e))
    );
  },
};

function amsterdamHour(date) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', hourCycle: 'h23' }).format(date));
}

// Manual preview / send, protected by the DIGEST_ADMIN_TOKEN secret.
//   GET  /api/digest                 dry run: returns each person's message, sends nothing
//   GET  /api/digest?hours=72        dry run over the last 72 hours instead of since the last digest
//   GET  /api/digest?user=<uuid>     only one person
//   POST /api/digest                 send now (same params), and advance everyone's window
async function handleDigestRequest(request, url, env) {
  const token = env.DIGEST_ADMIN_TOKEN;
  if (!token || request.headers.get('Authorization') !== 'Bearer ' + token) {
    return new Response('Not found', { status: 404 });
  }
  if (request.method !== 'GET' && request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }
  const hours = Number(url.searchParams.get('hours'));
  try {
    const result = await runDigest(env, {
      dryRun: request.method === 'GET',
      since: hours > 0 ? Date.now() - hours * 3600 * 1000 : undefined,
      userId: url.searchParams.get('user') || undefined,
    });
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: String(e && e.message || e) }, { status: 500 });
  }
}
