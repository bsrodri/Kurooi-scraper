const https = require('https');
const http = require('http');
const { URL } = require('url');
 
function fetchUrl(url, headers = {}, timeout = 15000) {
  return new Promise((resolve, reject) => {
    try {
      const parsed = new URL(url);
      const mod = parsed.protocol === 'https:' ? https : http;
      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
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
        if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
          const loc = res.headers.location;
          const redirectUrl = loc.startsWith('http') ? loc : `${parsed.protocol}//${parsed.hostname}${loc}`;
          return fetchUrl(redirectUrl, headers, timeout).then(resolve).catch(reject);
        }
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8'), code: res.statusCode, headers: res.headers }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    } catch(e) { reject(e); }
  });
}
 
function fetchBinary(url, headers = {}) {
  return new Promise((resolve, reject) => {
    try {
      const parsed = new URL(url);
      const mod = parsed.protocol === 'https:' ? https : http;
      const options = {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          'Referer': 'https://www.instagram.com/',
          'Origin': 'https://www.instagram.com',
          'Sec-Fetch-Dest': 'image',
          'Sec-Fetch-Mode': 'no-cors',
          'Sec-Fetch-Site': 'cross-site',
          ...headers
        },
        timeout: 10000
      };
      const req = mod.get(options, (res) => {
        if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
          return fetchBinary(res.headers.location, headers).then(resolve).catch(reject);
        }
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ 
          data: Buffer.concat(chunks), 
          code: res.statusCode, 
          contentType: res.headers['content-type'] || 'image/jpeg' 
        }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    } catch(e) { reject(e); }
  });
}
 
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
 
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
 
  const { action, username, url: reqUrl } = req.query;
 
  // ── ACTION: PROXY ──────────────────────────────────────────────────────────
  if (action === 'proxy') {
    if (!reqUrl || !reqUrl.startsWith('http')) {
      res.status(400).json({ error: 'URL no válida' }); return;
    }
    try {
      const result = await fetchBinary(reqUrl);
      if (result.code === 200 && result.data.length > 0) {
        res.setHeader('Content-Type', result.contentType);
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.status(200).send(result.data);
      } else {
        res.status(502).json({ error: 'No se pudo descargar la imagen', code: result.code });
      }
    } catch(e) { 
      res.status(500).json({ error: e.message }); 
    }
    return;
  }
 
  res.setHeader('Content-Type', 'application/json');
 
  // ── ACTION: INSTAGRAM ──────────────────────────────────────────────────────
  if (action === 'instagram') {
    const user = (username || '').replace(/[^a-zA-Z0-9._]/g, '').replace(/^@/, '');
    if (!user) { res.json({ success: false, error: 'Username vacío' }); return; }
 
    const posts = [];
    const addPost = (p) => {
      if (!p.url || posts.find(x => x.url === p.url)) return;
      posts.push(p);
    };
 
    // Método 1: Instagram JSON API oficial
    try {
      const r = await fetchUrl(
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${user}`,
        {
          'X-IG-App-ID': '936619743392459',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': 'https://www.instagram.com/',
          'Cookie': 'ig_did=1; ig_nrcb=1;'
        }
      );
      if (r.code === 200) {
        const data = JSON.parse(r.body);
        const edges = data?.data?.user?.edge_owner_to_timeline_media?.edges || [];
        edges.forEach(edge => {
          const node = edge.node || {};
          const url = node.display_url || node.thumbnail_src;
          const shortCode = node.shortcode || '';
          const caption = node.edge_media_to_caption?.edges?.[0]?.node?.text?.slice(0, 150) || '';
          const likes = node.edge_media_preview_like?.count || node.edge_liked_by?.count || 0;
          const isVideo = node.is_video || false;
          const views = node.video_view_count || 0;
          const timestamp = node.taken_at_timestamp || null;
          if (url) {
            addPost({
              url, shortCode,
              postUrl: shortCode ? `https://www.instagram.com/p/${shortCode}/` : '',
              caption, likes,
              comments: node.edge_media_to_comment?.count || 0,
              type: isVideo ? 'video' : 'image',
              views, timestamp,
              source: 'ig_api'
            });
          }
        });
      }
    } catch(e) {}
 
    // Método 2: Picnob fallback
    if (posts.length < 6) {
      try {
        const r = await fetchUrl(`https://www.picnob.com/profile/${user}/`);
        if (r.code === 200 && r.body) {
          const imgMatches = [...r.body.matchAll(/<img[^>]+src="([^"]+)"[^>]*>/gi)];
          imgMatches.forEach(m => {
            if (/cdninstagram|scontent|fbcdn/i.test(m[1])) {
              addPost({ url: m[1], shortCode: '', postUrl: '', caption: '', likes: 0, comments: 0, type: 'image', views: 0, timestamp: null, source: 'picnob' });
            }
          });
        }
      } catch(e) {}
    }
 
    // Método 3: Imginn fallback
    if (posts.length < 6) {
      try {
        const r = await fetchUrl(`https://imginn.com/${user}/`);
        if (r.code === 200 && r.body) {
          const imgMatches = [...r.body.matchAll(/<img[^>]+src="([^"]+)"[^>]*>/gi)];
          imgMatches.forEach(m => {
            if (/cdninstagram|scontent|fbcdn/i.test(m[1])) {
              addPost({ url: m[1], shortCode: '', postUrl: '', caption: '', likes: 0, comments: 0, type: 'image', views: 0, timestamp: null, source: 'imginn' });
            }
          });
        }
      } catch(e) {}
    }
 
    const result = posts.slice(0, 20);
    if (result.length > 0) {
      res.json({ success: true, posts: result, images: result, username: user, profileUrl: `https://www.instagram.com/${user}/` });
    } else {
      res.json({ success: false, error: 'No se pudieron obtener posts.', profileUrl: `https://www.instagram.com/${user}/` });
    }
    return;
  }
 
  // ── ACTION: WEB ────────────────────────────────────────────────────────────
  if (action === 'web') {
    if (!reqUrl || !reqUrl.startsWith('http')) {
      res.json({ success: false, error: 'URL no válida' }); return;
    }
    try {
      const r = await fetchUrl(reqUrl);
      if (!r.body) { res.json({ success: false, error: 'No se pudo acceder' }); return; }
      const images = [];
      const base = new URL(reqUrl);
      const addImg = (u) => {
        if (!u) return;
        let abs = u.startsWith('http') ? u : u.startsWith('//') ? 'https:'+u : u.startsWith('/') ? `${base.protocol}//${base.hostname}${u}` : reqUrl+'/'+u;
        if (abs && !images.includes(abs) && !/logo|icon|favicon/i.test(abs)) images.push(abs);
      };
      [...r.body.matchAll(/<img[^>]+(?:src|data-src)\s*=\s*["']([^"']+)["'][^>]*>/gi)].forEach(m => addImg(m[1]));
      [...r.body.matchAll(/property="og:image"\s+content="([^"]+)"/gi)].forEach(m => images.unshift(m[1]));
      const result = [...new Set(images)].slice(0, 30).map(u => ({ url: u, source: 'web' }));
      res.json(result.length > 0 ? { success: true, images: result } : { success: false, error: 'No se encontraron imágenes' });
    } catch(e) { res.json({ success: false, error: e.message }); }
    return;
  }
 
  res.json({ success: false, error: 'Acción desconocida: ' + action });
};
