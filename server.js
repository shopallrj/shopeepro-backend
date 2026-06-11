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

    // Lista de feeds RSS a tentar
  const feedSources = [
    { key: 'promobit', urls: [
      'https://www.promobit.com.br/feed/',
      'https://promobit.com.br/feed/',
      'https://www.promobit.com.br/rss/',
    ], enabled: sources.includes('promobit') },
    { key: 'pelando', urls: [
      'https://www.pelando.com.br/feed',
      'https://pelando.com.br/feed',
      'https://www.pelando.com.br/rss',
    ], enabled: sources.includes('pelando') },
  ];

  for (const src of feedSources) {
    if (!src.enabled) continue;
    try {
      const now = Date.now();
      if (!cache[src.key] || (now - (cache.lastFetch[src.key]||0)) > CACHE_TTL) {
        let items = null;
        for (const url of src.urls) {
          try {
            items = await parseRSS(url);
            if (items && items.length > 0) {
              console.log(`[${src.key}] ${items.length} itens via ${url}`);
              break;
            }
          } catch(e) {
            console.warn(`[${src.key}] falhou ${url}: ${e.message}`);
          }
        }
        if (items && items.length > 0) {
          cache[src.key] = items;
          cache.lastFetch[src.key] = now;
        } else {
          console.warn(`[${src.key}] todos os feeds falharam`);
          cache[src.key] = cache[src.key] || [];
        }
      }
      const normalized = (cache[src.key]||[]).map(i => normalizeItem(i, src.key));
      allItems.push(...normalized);
      console.log(`[${src.key}] ${normalized.length} itens normalizados, ${normalized.filter(i=>i.isShopee).length} Shopee`);
    } catch(e) {
      console.warn(`[${src.key}]`, e.message);
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

    const feedUrls = {
      promobit: ['https://www.promobit.com.br/feed/', 'https://promobit.com.br/feed/'],
      pelando: ['https://www.pelando.com.br/feed', 'https://pelando.com.br/feed'],
    };

    for (const source of sources) {
      try {
        const now = Date.now();
        if (!cache[source] || (now - (cache.lastFetch[source] || 0)) > CACHE_TTL) {
          let items = null;
          for (const url of (feedUrls[source] || [])) {
            try { items = await parseRSS(url); if (items?.length > 0) break; } catch(e) {}
          }
          if (items?.length > 0) { cache[source] = items; cache.lastFetch[source] = now; }
          else { cache[source] = cache[source] || []; }
        }
        allItems.push(...(cache[source]||[]).map(i => normalizeItem(i, source)));
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
      promobit: cache.promobit ? {
        items: cache.promobit.length,
        shopeeItems: cache.promobit.map(i => normalizeItem(i,'promobit')).filter(i=>i.isShopee).length,
        lastFetch: cache.lastFetch.promobit ? new Date(cache.lastFetch.promobit).toISOString() : null,
      } : null,
      pelando: cache.pelando ? {
        items: cache.pelando.length,
        shopeeItems: cache.pelando.map(i => normalizeItem(i,'pelando')).filter(i=>i.isShopee).length,
        lastFetch: cache.lastFetch.pelando ? new Date(cache.lastFetch.pelando).toISOString() : null,
      } : null,
    },
  });
});

// Debug: ver itens crus do feed
app.get('/debug/feed/:source', async (req, res) => {
  const source = req.params.source;
  const feedUrls = {
    promobit: ['https://www.promobit.com.br/feed/', 'https://promobit.com.br/feed/'],
    pelando: ['https://www.pelando.com.br/feed', 'https://pelando.com.br/feed'],
  };
  const urls = feedUrls[source];
  if (!urls) return res.status(400).json({ error: 'fonte inválida' });

  for (const url of urls) {
    try {
      const items = await parseRSS(url);
      const normalized = items.map(i => normalizeItem(i, source));
      return res.json({
        url, total: items.length,
        shopee: normalized.filter(i=>i.isShopee).length,
        sample: normalized.slice(0,5).map(i => ({ title:i.title, isShopee:i.isShopee, link:i.link?.slice(0,80) })),
      });
    } catch(e) {
      console.warn(e.message);
    }
  }
  res.status(500).json({ error: 'todos os feeds falharam' });
});

app.listen(PORT, () => {
  console.log(`ShopeePro Backend rodando na porta ${PORT}`);
});
