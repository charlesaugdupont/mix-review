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

    // All other requests — serve static assets as normal
    return env.ASSETS.fetch(request);
  }
}
