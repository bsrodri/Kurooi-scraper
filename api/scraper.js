const https = require('https');
const http = require('http');
const { URL } = require('url');

function fetchUrl(url, headers = {}, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        'Cache-Control': 'no-cache',
        ...headers
      },
      timeout
    };
    const req = mod.get(options, (res) => {
      // Handle redirects
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http') 
          ? res.headers.location 
          : `${parsed.protocol}//${parsed.hostname}${res.headers.location}`;
        return fetchUrl(redirectUrl, headers, timeout).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8'), code: res.statusCode }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function isValidImageUrl(url) {
  if (!url || url.length < 10) return false;
  if (!/\.(jpg|jpeg|png|webp|gif)/i.test(url) &&
      !/(photo|media|image|img|foto|cdn)/i.test(url) &&
      !/cdninstagram|fbcdn|igsonar|scontent/i.test(url)) return false;
  if (/logo|icon|favicon|sprite|blank|pixel|tracker|analytics|placeholder/i.test(url)) return false;
  return true;
}

function absoluteUrl(url, base) {
  if (!url) return null;
  if (url.startsWith('http')) return url;
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('/')) {
    const p = new URL(base);
    return p.protocol + '//' + p.hostname + url;
  }
  return base.replace(/\/$/, '') + '/' + url.replace(/^\//, '');
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { action, username, url: reqUrl } = req.query;

  // ── ACTION: INSTAGRAM ──────────────────────────────────────────────────────
  if (action === 'instagram') {
    const user = (username || '').replace(/[^a-zA-Z0-9._]/g, '').replace(/^@/, '');
    if (!user) { res.json({ success: false, error: 'Username vacío' }); return; }

    const images = [];
    const addImage = (url, caption = '', source = 'instagram') => {
      if (url && !images.find(i => i.url === url)) {
        images.push({ url, caption, source });
      }
    };

    // Método 1: Picnob
    try {
      const r = await fetchUrl(`https://www.picnob.com/profile/${user}/`);
      if (r.code === 200) {
        const matches = [...r.body.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)];
        matches.forEach(m => {
          if (/cdninstagram|scontent|fbcdn/i.test(m[1])) addImage(m[1]);
        });
      }
    } catch(e) {}

    // Método 2: Imginn
    if (images.length < 12) {
      try {
        const r = await fetchUrl(`https://imginn.com/${user}/`);
        if (r.code === 200) {
          const matches = [...r.body.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)];
          matches.forEach(m => {
            if (/cdninstagram|scontent|fbcdn/i.test(m[1])) addImage(m[1]);
          });
        }
      } catch(e) {}
    }

    // Método 3: Instagram JSON API
    if (images.length < 12) {
      try {
        const r = await fetchUrl(
          `https://www.instagram.com/api/v1/users/web_profile_info/?username=${user}`,
          { 'X-IG-App-ID': '936619743392459', 'X-Requested-With': 'XMLHttpRequest', 'Referer': 'https://www.instagram.com/' }
        );
        if (r.code === 200) {
          const data = JSON.parse(r.body);
          const edges = data?.data?.user?.edge_owner_to_timeline_media?.edges || [];
          edges.forEach(edge => {
            const node = edge.node || {};
            const url = node.display_url || node.thumbnail_src;
            const caption = node.edge_media_to_caption?.edges?.[0]?.node?.text?.slice(0, 100) || '';
            if (url) addImage(url, caption);
          });
        }
      } catch(e) {}
    }

    const result = images.slice(0, 20);
    if (result.length > 0) {
      res.json({ success: true, images: result, username: user, profileUrl: `https://www.instagram.com/${user}/` });
    } else {
      res.json({ success: false, error: 'No se pudieron obtener imágenes. Instagram bloquea el acceso automático.', profileUrl: `https://www.instagram.com/${user}/` });
    }
    return;
  }

  // ── ACTION: PROXY ──────────────────────────────────────────────────────────
  if (action === 'proxy') {
    const targetUrl = reqUrl;
    if (!targetUrl || !targetUrl.startsWith('http')) {
      res.status(400).json({ error: 'URL no válida' }); return;
    }
    try {
      const parsed = new URL(targetUrl);
      const mod = parsed.protocol === 'https:' ? https : http;
      const options = {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          'Referer': 'https://www.instagram.com/',
          'Sec-Fetch-Dest': 'image',
          'Sec-Fetch-Mode': 'no-cors',
        }
      };
      mod.get(options, (imgRes) => {
        res.setHeader('Content-Type', imgRes.headers['content-type'] || 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.setHeader('Access-Control-Allow-Origin', '*');
        imgRes.pipe(res);
      }).on('error', () => res.status(502).json({ error: 'No se pudo descargar la imagen' }));
    } catch(e) { res.status(500).json({ error: e.message }); }
    return;
  }

  // ── ACTION: WEB ────────────────────────────────────────────────────────────
  if (action === 'web') {
    const targetUrl = reqUrl;
    if (!targetUrl || !targetUrl.startsWith('http')) {
      res.json({ success: false, error: 'URL no válida' }); return;
    }
    try {
      const r = await fetchUrl(targetUrl);
      if (!r.body) { res.json({ success: false, error: 'No se pudo acceder' }); return; }

      const images = [];
      const addImg = (url) => {
        const abs = absoluteUrl(url, targetUrl);
        if (abs && isValidImageUrl(abs) && !images.includes(abs)) images.push(abs);
      };

      [...r.body.matchAll(/<img[^>]+(?:src|data-src)\s*=\s*["']([^"']+)["'][^>]*>/gi)].forEach(m => addImg(m[1]));
      [...r.body.matchAll(/property="og:image"\s+content="([^"]+)"/gi)].forEach(m => images.unshift(m[1]));

      const result = [...new Set(images)].slice(0, 30).map(u => ({ url: u, source: 'web' }));
      if (result.length > 0) {
        res.json({ success: true, images: result, total: result.length });
      } else {
        res.json({ success: false, error: 'No se encontraron imágenes' });
      }
    } catch(e) { res.json({ success: false, error: e.message }); }
    return;
  }

  res.json({ success: false, error: 'Acción desconocida: ' + action });
};
