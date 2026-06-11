const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const xml2js = require('xml2js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.options('*', cors());
app.use(express.json());

// ── Cache simples em memória ──────────────────────────────────────
const cache = { promobit: null, pelando: null, lastFetch: {} };
const CACHE_TTL = 10 * 60 * 1000; // 10 minutos

// ── Rota de teste ─────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'ShopeePro Backend rodando!' });
});

// ── Parser de RSS ─────────────────────────────────────────────────
async function parseRSS(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ShopeePro/1.0)' },
    timeout: 10000,
  });
  if (!res.ok) throw new Error(`RSS erro ${res.status}: ${url}`);
  const xml = await res.text();
  const parsed = await xml2js.parseStringPromise(xml, { explicitArray: false });
  return parsed?.rss?.channel?.item || parsed?.feed?.entry || [];
}

// ── Normaliza item do RSS ─────────────────────────────────────────
function normalizeItem(item, source) {
  const title = item.title?._ || item.title || '';
  const description = item.description?._ || item.description || item.summary?._ || item.summary || '';
  const link = item.link?.href || item.link || item.guid?._ || item.guid || '';
  const pubDate = item.pubDate || item.published || item.updated || '';
  const image = extractImage(description) || item.enclosure?.url || '';

  // Extrai preço da descrição
  const priceMatch = (title + ' ' + description).match(/R\$\s*([\d.,]+)/);
  const price = priceMatch ? parseFloat(priceMatch[1].replace('.','').replace(',','.')) : null;

  // Extrai desconto
  const discMatch = (title + ' ' + description).match(/(\d{1,3})\s*%\s*(?:off|de desconto|OFF)/i);
  const discount = discMatch ? parseInt(discMatch[1]) : 0;

  // Verifica se é Shopee
  const isShopee = /shopee/i.test(title + description + link);

  return { title, description, link, pubDate, image, price, discount, isShopee, source };
}

function extractImage(html) {
  const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return match ? match[1] : null;
}

// ── Converte link para afiliado Shopee ───────────────────────────
function convertToAffiliateLink(url, subId = '') {
  if (!url) return url;

  // Se já é link de afiliado, retorna como está
  if (url.includes('shope.ee') || url.includes('s.shopee')) return url;

  // Shopee usa o formato: https://shope.ee/xxxxx
  // Para converter, usamos a API da Shopee (quando disponível)
  // Por enquanto, adiciona parâmetro de rastreamento
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes('shopee')) {
      if (subId) parsed.searchParams.set('af_sub_siteid', subId);
      parsed.searchParams.set('af_channel', 'ShopeePro');
      return parsed.toString();
    }
  } catch(e) {}
  return url;
}

// ── ROTA: Buscar ofertas Shopee via RSS ───────────────────────────
app.post('/shopee/rss', async (req, res) => {
  const { keyword = '', minDiscount = 0, sources = ['promobit', 'pelando'], subId = '' } = req.body;

  try {
    const allItems = [];

    // Busca Promobit RSS
    if (sources.includes('promobit')) {
      try {
        const cacheKey = 'promobit';
        const now = Date.now();
        if (!cache[cacheKey] || (now - cache.lastFetch[cacheKey]) > CACHE_TTL) {
          const items = await parseRSS('https://www.promobit.com.br/feed/');
          cache[cacheKey] = items;
          cache.lastFetch[cacheKey] = now;
          console.log(`[Promobit] ${items.length} itens carregados`);
        }
        const normalized = cache[cacheKey].map(i => normalizeItem(i, 'promobit'));
        allItems.push(...normalized);
      } catch(e) {
        console.warn('[Promobit RSS]', e.message);
      }
    }

    // Busca Pelando RSS
    if (sources.includes('pelando')) {
      try {
        const cacheKey = 'pelando';
        const now = Date.now();
        if (!cache[cacheKey] || (now - cache.lastFetch[cacheKey]) > CACHE_TTL) {
          const items = await parseRSS('https://www.pelando.com.br/feed');
          cache[cacheKey] = items;
          cache.lastFetch[cacheKey] = now;
          console.log(`[Pelando] ${items.length} itens carregados`);
        }
        const normalized = cache[cacheKey].map(i => normalizeItem(i, 'pelando'));
        allItems.push(...normalized);
      } catch(e) {
        console.warn('[Pelando RSS]', e.message);
      }
    }

    // Filtra só Shopee
    let shopeeItems = allItems.filter(i => i.isShopee);

    // Filtra por keyword
    if (keyword) {
      const q = keyword.toLowerCase();
      shopeeItems = shopeeItems.filter(i =>
        i.title.toLowerCase().includes(q) ||
        i.description.toLowerCase().includes(q)
      );
    }

    // Filtra por desconto mínimo
    if (minDiscount > 0) {
      shopeeItems = shopeeItems.filter(i => i.discount >= minDiscount);
    }

    // Converte links para afiliado
    shopeeItems = shopeeItems.map(i => ({
      ...i,
      affiliateLink: convertToAffiliateLink(i.link, subId),
    }));

    // Ordena por data mais recente
    shopeeItems.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

    res.json({ offers: shopeeItems, total: shopeeItems.length });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ROTA: Todas as ofertas (não só Shopee) ────────────────────────
app.post('/offers/all', async (req, res) => {
  const { keyword = '', minDiscount = 0, sources = ['promobit', 'pelando'], shopeeOnly = false } = req.body;

  try {
    const allItems = [];

    for (const source of sources) {
      try {
        const feedUrl = source === 'promobit'
          ? 'https://www.promobit.com.br/feed/'
          : 'https://www.pelando.com.br/feed';

        const now = Date.now();
        if (!cache[source] || (now - (cache.lastFetch[source] || 0)) > CACHE_TTL) {
          const items = await parseRSS(feedUrl);
          cache[source] = items;
          cache.lastFetch[source] = now;
        }
        allItems.push(...cache[source].map(i => normalizeItem(i, source)));
      } catch(e) {
        console.warn(`[${source}]`, e.message);
      }
    }

    let filtered = shopeeOnly ? allItems.filter(i => i.isShopee) : allItems;

    if (keyword) {
      const q = keyword.toLowerCase();
      filtered = filtered.filter(i =>
        i.title.toLowerCase().includes(q) ||
        i.description.toLowerCase().includes(q)
      );
    }

    if (minDiscount > 0) {
      filtered = filtered.filter(i => i.discount >= minDiscount);
    }

    filtered.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

    res.json({ offers: filtered, total: filtered.length });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ROTA: Converter link para afiliado ────────────────────────────
app.post('/shopee/convert', async (req, res) => {
  const { url, subId = '', appId, secret } = req.body;

  if (!url) return res.status(400).json({ error: 'URL é obrigatória' });

  // Se tem credenciais da API Shopee, usa a API oficial
  if (appId && secret) {
    try {
      const timestamp = Math.floor(Date.now() / 1000);
      const payload = {
        original_url: url,
        sub_ids: subId ? [subId] : [],
      };

      const query = `
        mutation generateAffiliateLink($input: GenerateAffiliateLinkInput!) {
          generateAffiliateLink(input: $input) {
            affiliate_link
          }
        }
      `;

      const response = await fetch('https://open-api.affiliate.shopee.com.br/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `SHA256 app_id=${appId},timestamp=${timestamp}`,
        },
        body: JSON.stringify({ query, variables: { input: payload } }),
      });

      if (response.ok) {
        const data = await response.json();
        const affiliateLink = data?.data?.generateAffiliateLink?.affiliate_link;
        if (affiliateLink) {
          return res.json({ affiliateLink, original: url, method: 'api' });
        }
      }
    } catch(e) {
      console.warn('[Shopee API]', e.message);
    }
  }

  // Fallback: converte manualmente adicionando parâmetros
  const affiliateLink = convertToAffiliateLink(url, subId);
  res.json({ affiliateLink, original: url, method: 'manual' });
});

// ── ROTA: Converter lote de links ─────────────────────────────────
app.post('/shopee/convert-batch', async (req, res) => {
  const { urls = [], subId = '', appId, secret } = req.body;
  if (!urls.length) return res.status(400).json({ error: 'URLs são obrigatórias' });

  const results = await Promise.all(
    urls.map(async url => {
      try {
        const r = await fetch(`http://localhost:${PORT}/shopee/convert`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, subId, appId, secret }),
        });
        return await r.json();
      } catch(e) {
        return { original: url, affiliateLink: url, error: e.message };
      }
    })
  );

  res.json({ results });
});

// ── ROTA: Status dos feeds ────────────────────────────────────────
app.get('/status', (req, res) => {
  res.json({
    status: 'ok',
    cache: {
      promobit: cache.promobit ? { items: cache.promobit.length, lastFetch: new Date(cache.lastFetch.promobit).toISOString() } : null,
      pelando: cache.pelando ? { items: cache.pelando.length, lastFetch: new Date(cache.lastFetch.pelando).toISOString() } : null,
    },
  });
});

app.listen(PORT, () => {
  console.log(`ShopeePro Backend rodando na porta ${PORT}`);
});
