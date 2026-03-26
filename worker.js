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

      const cache = caches.default;
      let response = await cache.match(request);
      if (response) return response;

      response = await fetch(supabaseUrl);
      if (!response.ok) return new Response('Upstream error', { status: response.status });

      const toCache = new Response(response.body, response);
      toCache.headers.set('Cache-Control', 'public, max-age=2592000');
      Object.entries(corsHeaders).forEach(([k, v]) => toCache.headers.set(k, v));
      cache.put(request, toCache.clone());
      return toCache;
    }

    // All other requests — serve static assets as normal
    return env.ASSETS.fetch(request);
  }
}