const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.options('*', cors());
app.use(express.json());

// ── Cache ─────────────────────────────────────────────────────────
const cache = {};
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

// ── Canais do Telegram com ofertas da Shopee ──────────────────────
const SHOPEE_CHANNELS = [
  'shopeebrasil',
  'ofertasshopee',
  'cuponshopeebr',
  'achados_shopee',
  'shopeeofertas',
  'promododobr',
];

// ── Lê mensagens de canal público do Telegram ─────────────────────
async function readTelegramChannel(channel) {
  const url = `https://t.me/s/${channel}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'pt-BR,pt;q=0.9',
    },
    timeout: 15000,
  });

  if (!res.ok) throw new Error(`Telegram ${channel}: HTTP ${res.status}`);
  const html = await res.text();

  // Extrai mensagens do HTML do Telegram
  const messages = [];
  const msgRegex = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
  const linkRegex = /href="(https?:\/\/[^"]+)"/g;
  const imgRegex = /<a[^>]+style="background-image:url\('([^']+)'\)"/g;
  const dateRegex = /<time[^>]+datetime="([^"]+)"/g;

  // Extrai blocos de mensagem
  const blockRegex = /<div class="tgme_widget_message[^"]*"[^>]*data-post="([^"]+)"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g;
  let blockMatch;

  while ((blockMatch = blockRegex.exec(html)) !== null) {
    const block = blockMatch[2];

    // Texto da mensagem
    const textMatch = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(block);
    const rawText = textMatch ? textMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';

    // Links na mensagem
    const links = [];
    let linkMatch;
    const linkReg = /href="(https?:\/\/[^"]+)"/g;
    while ((linkMatch = linkReg.exec(block)) !== null) {
      links.push(linkMatch[1]);
    }

    // Data
    const dateMatch = /<time[^>]+datetime="([^"]+)"/.exec(block);
    const date = dateMatch ? dateMatch[1] : '';

    // Imagem
    const imgMatch = /style="background-image:url\('([^']+)'\)"/.exec(block);
    const image = imgMatch ? imgMatch[1] : '';

    if (rawText.length > 10) {
      messages.push({ text: rawText, links, date, image, channel });
    }
  }

  // Fallback: regex mais simples
  if (messages.length === 0) {
    const simpleRegex = /<div class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/g;
    let m;
    while ((m = simpleRegex.exec(html)) !== null) {
      const text = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (text.length > 20) {
        messages.push({ text, links: [], date: '', image: '', channel });
      }
    }
  }

  return messages;
}

// ── Normaliza mensagem do Telegram em oferta ──────────────────────
function parseOffer(msg) {
  const text = msg.text;

  // Extrai preço
  const priceMatch = text.match(/R\$\s*([\d.,]+)/);
  const price = priceMatch ? parseFloat(priceMatch[1].replace(/\./g,'').replace(',','.')) : null;

  // Extrai desconto
  const discMatch = text.match(/(\d{1,3})\s*%\s*(?:off|de desconto|OFF|desconto)/i)
    || text.match(/-(\d{1,3})%/);
  const discount = discMatch ? parseInt(discMatch[1]) : 0;

  // Pega link da Shopee
  const shopeeLink = msg.links.find(l =>
    l.includes('shopee') || l.includes('shope.ee') || l.includes('s.shopee')
  ) || msg.links[0] || '';

  // Título: primeira linha não vazia
  const title = text.split(/[\n.!]/)[0].trim().slice(0, 120);

  // Verifica se é Shopee
  const isShopee = /shopee/i.test(text + shopeeLink);

  return {
    id: `${msg.channel}-${msg.date}-${Math.random().toString(36).slice(2,6)}`,
    title,
    description: text.slice(0, 300),
    price,
    discount,
    link: shopeeLink,
    affiliateLink: shopeeLink, // será substituído pelo link de afiliado
    image: msg.image || '',
    date: msg.date,
    source: msg.channel,
    isShopee,
  };
}

// ── Converte link para afiliado Shopee ────────────────────────────
function toAffiliateLink(url, subId = '') {
  if (!url) return url;
  try {
    if (url.includes('shope.ee')) return url; // já é curto, precisa da API
    const u = new URL(url);
    if (u.hostname.includes('shopee')) {
      if (subId) u.searchParams.set('af_sub_siteid', subId);
      u.searchParams.set('af_channel', 'ShopeePro');
      return u.toString();
    }
  } catch(e) {}
  return url;
}

// ── ROTA: status ──────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'ShopeePro Backend rodando!', version: '2.0' });
});

app.get('/status', (req, res) => {
  const cacheInfo = {};
  for (const [k, v] of Object.entries(cache)) {
    cacheInfo[k] = { items: v.data?.length || 0, age: Math.round((Date.now() - v.ts) / 1000) + 's' };
  }
  res.json({ status: 'ok', cache: cacheInfo, channels: SHOPEE_CHANNELS });
});

// ── ROTA: buscar ofertas via Telegram ────────────────────────────
app.post('/shopee/rss', async (req, res) => {
  const { keyword = '', minDiscount = 0, subId = '', channels } = req.body;
  const targetChannels = channels || SHOPEE_CHANNELS;

  try {
    let allOffers = [];

    for (const channel of targetChannels) {
      try {
        const cacheKey = `tg_${channel}`;
        const now = Date.now();

        if (!cache[cacheKey] || (now - cache[cacheKey].ts) > CACHE_TTL) {
          console.log(`[Telegram] Lendo @${channel}...`);
          const messages = await readTelegramChannel(channel);
          const offers = messages.map(parseOffer).filter(o => o.title.length > 5);
          cache[cacheKey] = { data: offers, ts: now };
          console.log(`[Telegram] @${channel}: ${offers.length} ofertas (${offers.filter(o=>o.isShopee).length} Shopee)`);
        }

        allOffers.push(...cache[cacheKey].data);
      } catch(e) {
        console.warn(`[Telegram @${channel}]`, e.message);
      }
    }

    // Filtra só Shopee
    let offers = allOffers.filter(o => o.isShopee);

    // Filtro por keyword
    if (keyword) {
      const q = keyword.toLowerCase();
      offers = offers.filter(o =>
        o.title.toLowerCase().includes(q) ||
        o.description.toLowerCase().includes(q)
      );
    }

    // Filtro por desconto
    if (minDiscount > 0) {
      offers = offers.filter(o => o.discount >= minDiscount);
    }

    // Converte links para afiliado
    offers = offers.map(o => ({ ...o, affiliateLink: toAffiliateLink(o.link, subId) }));

    // Ordena por data mais recente
    offers.sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json({ offers, total: offers.length });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ROTA: todas as ofertas (não só Shopee) ────────────────────────
app.post('/offers/all', async (req, res) => {
  const { keyword = '', minDiscount = 0, shopeeOnly = false } = req.body;

  try {
    let allOffers = [];
    for (const channel of SHOPEE_CHANNELS) {
      try {
        const cacheKey = `tg_${channel}`;
        const now = Date.now();
        if (!cache[cacheKey] || (now - cache[cacheKey].ts) > CACHE_TTL) {
          const messages = await readTelegramChannel(channel);
          cache[cacheKey] = { data: messages.map(parseOffer).filter(o => o.title.length > 5), ts: now };
        }
        allOffers.push(...cache[cacheKey].data);
      } catch(e) { console.warn(`@${channel}`, e.message); }
    }

    let filtered = shopeeOnly ? allOffers.filter(o => o.isShopee) : allOffers;
    if (keyword) { const q = keyword.toLowerCase(); filtered = filtered.filter(o => o.title.toLowerCase().includes(q) || o.description.toLowerCase().includes(q)); }
    if (minDiscount > 0) filtered = filtered.filter(o => o.discount >= minDiscount);
    filtered.sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json({ offers: filtered, total: filtered.length });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ROTA: converter link ──────────────────────────────────────────
app.post('/shopee/convert', async (req, res) => {
  const { url, subId = '', appId, secret } = req.body;
  if (!url) return res.status(400).json({ error: 'URL obrigatória' });

  // Com API Shopee
  if (appId && secret) {
    try {
      const timestamp = Math.floor(Date.now() / 1000);
      const query = `mutation generateAffiliateLink($input: GenerateAffiliateLinkInput!) { generateAffiliateLink(input: $input) { affiliate_link } }`;
      const response = await fetch('https://open-api.affiliate.shopee.com.br/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `SHA256 app_id=${appId},timestamp=${timestamp}` },
        body: JSON.stringify({ query, variables: { input: { original_url: url, sub_ids: subId ? [subId] : [] } } }),
      });
      if (response.ok) {
        const data = await response.json();
        const affiliateLink = data?.data?.generateAffiliateLink?.affiliate_link;
        if (affiliateLink) return res.json({ affiliateLink, original: url, method: 'api' });
      }
    } catch(e) { console.warn('[Shopee API]', e.message); }
  }

  // Fallback manual
  res.json({ affiliateLink: toAffiliateLink(url, subId), original: url, method: 'manual' });
});

// ── ROTA: debug canal ─────────────────────────────────────────────
app.get('/debug/:channel', async (req, res) => {
  const channel = req.params.channel;
  try {
    const messages = await readTelegramChannel(channel);
    const offers = messages.map(parseOffer);
    res.json({
      channel, total: messages.length, shopee: offers.filter(o=>o.isShopee).length,
      sample: offers.slice(0,5).map(o => ({ title: o.title, isShopee: o.isShopee, discount: o.discount, link: o.link?.slice(0,80) })),
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`ShopeePro Backend v2 rodando na porta ${PORT}`);
});
