// Vercel Serverless Function to proxy VNDB images with CORS headers
const ALLOWED_IMG_HOST = 't.vndb.org';

module.exports = async (req, res) => {
  const target = req.query.u;
  if (!target) {
    res.status(400).send('bad url');
    return;
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    res.status(400).send('bad url');
    return;
  }

  if (parsed.protocol !== 'https:' || parsed.hostname !== ALLOWED_IMG_HOST) {
    res.status(403).send('forbidden host');
    return;
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=604800, immutable');

  try {
    const upstream = await fetch(parsed.href, {
      headers: { 'User-Agent': 'VN-Topster/1.0' },
    });

    if (!upstream.ok) {
      res.status(upstream.status).end();
      return;
    }

    const type = upstream.headers.get('content-type') || 'image/jpeg';
    const buffer = Buffer.from(await upstream.arrayBuffer());

    res.setHeader('Content-Type', type);
    res.status(200).send(buffer);
  } catch (err) {
    res.status(502).send('upstream error');
  }
};
