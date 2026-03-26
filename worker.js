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

      // Forward range header if present
      const upstreamHeaders = {};
      const range = request.headers.get('Range');
      if (range) upstreamHeaders['Range'] = range;

      const response = await fetch(supabaseUrl, { headers: upstreamHeaders });

      if (!response.ok && response.status !== 206) {
        return new Response('Upstream error', { status: response.status });
      }

      const newHeaders = new Headers(response.headers);
      Object.entries(corsHeaders).forEach(([k, v]) => newHeaders.set(k, v));
      newHeaders.set('Cache-Control', 'public, max-age=2592000');

      return new Response(response.body, {
        status: response.status,
        headers: newHeaders,
      });
    }

    // All other requests — serve static assets as normal
    return env.ASSETS.fetch(request);
  }
}
