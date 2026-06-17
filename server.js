const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.options('*', cors());
app.use(express.json());

const SHOPEE_API = 'https://open-api.affiliate.shopee.com.br/graphql';

// Formato oficial: SHA256(AppId + Timestamp + Payload + Secret)
function buildShopeeHeaders(appId, secret, payload) {
  const timestamp = Math.floor(Date.now() / 1000);
  const factor = `${appId}${timestamp}${payload}${secret}`;
  const sign = crypto.createHash('sha256').update(factor).digest('hex');
  return {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${sign}`,
    },
    timestamp,
    sign,
  };
}

async function shopeeQuery(appId, secret, query, variables = {}) {
  const body = JSON.stringify({ query, variables });
  const { headers } = buildShopeeHeaders(appId, secret, body);
  console.log('[Shopee] Auth:', headers.Authorization.slice(0, 80) + '...');

  const res = await fetch(SHOPEE_API, { method: 'POST', headers, body });
  const text = await res.text();
  console.log('[Shopee] Status:', res.status, '| Body:', text.slice(0, 400));

  if (!res.ok) throw new Error(`Shopee HTTP ${res.status}: ${text.slice(0, 200)}`);

  let data;
  try { data = JSON.parse(text); } catch(e) {
    throw new Error('Resposta inválida: ' + text.slice(0, 200));
  }
  if (data.errors) throw new Error(data.errors[0]?.message || JSON.stringify(data.errors[0]));
  return data.data;
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'ShopeePro Backend rodando!', version: '5.0' });
});

// ── Ping ─────────────────────────────────────────────────────────
app.post('/shopee/ping', async (req, res) => {
  const { appId, secret } = req.body;
  if (!appId || !secret) return res.status(400).json({ error: 'appId e secret obrigatórios' });
  try {
    const query = `query { productOfferV2(input: { page: 1, limit: 1 }) { nodes { itemId productName } } }`;
    const data = await shopeeQuery(appId, secret, query, {});
    const sample = data?.productOfferV2?.nodes?.[0]?.productName || '(sem produto)';
    res.json({ ok: true, message: 'Credenciais válidas!', sample });
  } catch(err) {
    res.status(401).json({ ok: false, error: err.message });
  }
});

// ── Buscar produtos ───────────────────────────────────────────────
app.post('/shopee/search', async (req, res) => {
  const { appId, secret, keyword = '', minComm = 0, extraOnly = false } = req.body;
  if (!appId || !secret) return res.status(400).json({ error: 'appId e secret obrigatórios' });
  try {
    const query = `
      query productOfferV2($input: ProductOfferV2Input!) {
        productOfferV2(input: $input) {
          nodes {
            itemId shopId productName imageUrl priceMin priceMax
            commissionRate sellerCommissionRate sales ratingStar
            priceDiscountRate shopName productLink offerLink
          }
          pageInfo { hasNextPage }
        }
      }
    `;
    const variables = {
      input: {
        page: 1, limit: 30,
        keyword: keyword || undefined,
        sortType: 5,
        isAMSOffer: extraOnly ? true : undefined,
      },
    };
    const data = await shopeeQuery(appId, secret, query, variables);
    const items = data?.productOfferV2?.nodes || [];

    const products = items
      .filter(p => {
        const comm = (parseFloat(p.commissionRate || 0) + parseFloat(p.sellerCommissionRate || 0)) * 100;
        return comm >= minComm;
      })
      .map(p => {
        const price = parseFloat(p.priceMin || 0);
        const commRate = Math.round(parseFloat(p.commissionRate || 0) * 100 * 10) / 10;
        const sellerComm = Math.round(parseFloat(p.sellerCommissionRate || 0) * 100 * 10) / 10;
        const discount = p.priceDiscountRate || 0;
        return {
          id: `${p.shopId}-${p.itemId}`,
          title: p.productName, price,
          originalPrice: discount > 0 ? Math.round(price / (1 - discount / 100)) : null,
          discount, image: p.imageUrl, shop: p.shopName,
          rating: parseFloat(p.ratingStar || 0), sales: p.sales || 0,
          commissionRate: commRate, sellerComm,
          totalComm: Math.round((commRate + sellerComm) * 10) / 10,
          link: p.productLink, affiliateLink: p.offerLink || p.productLink,
        };
      });

    res.json({ products, total: products.length });
  } catch(err) {
    console.error('[/shopee/search]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Relâmpago ─────────────────────────────────────────────────────
app.post('/shopee/flash', async (req, res) => {
  const { appId, secret, minComm = 0 } = req.body;
  if (!appId || !secret) return res.status(400).json({ error: 'appId e secret obrigatórios' });
  try {
    const query = `
      query productOfferV2($input: ProductOfferV2Input!) {
        productOfferV2(input: $input) {
          nodes {
            itemId shopId productName imageUrl priceMin
            commissionRate sellerCommissionRate shopName
            productLink offerLink priceDiscountRate periodEndTime
          }
          pageInfo { hasNextPage }
        }
      }
    `;
    const variables = { input: { page: 1, limit: 20, sortType: 5 } };
    const data = await shopeeQuery(appId, secret, query, variables);
    const items = data?.productOfferV2?.nodes || [];

    const products = items
      .filter(p => (parseFloat(p.commissionRate || 0) + parseFloat(p.sellerCommissionRate || 0)) * 100 >= minComm)
      .map(p => {
        const price = parseFloat(p.priceMin || 0);
        const commRate = Math.round(parseFloat(p.commissionRate || 0) * 100 * 10) / 10;
        const sellerComm = Math.round(parseFloat(p.sellerCommissionRate || 0) * 100 * 10) / 10;
        return {
          id: `${p.shopId}-${p.itemId}`,
          title: p.productName, price, discount: p.priceDiscountRate || 0,
          image: p.imageUrl, shop: p.shopName,
          commissionRate: commRate, sellerComm,
          totalComm: Math.round((commRate + sellerComm) * 10) / 10,
          link: p.productLink, affiliateLink: p.offerLink || p.productLink,
          isFlash: true, endTime: p.periodEndTime,
        };
      });

    res.json({ products, total: products.length });
  } catch(err) {
    console.error('[/shopee/flash]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Converter link ────────────────────────────────────────────────
app.post('/shopee/convert', async (req, res) => {
  const { url, subId = '', appId, secret } = req.body;
  if (!url) return res.status(400).json({ error: 'URL obrigatória' });
  if (appId && secret) {
    try {
      const query = `mutation generateShortLink($input: GenerateShortLinkInput!) { generateShortLink(input: $input) { shortLink } }`;
      const variables = { input: { originUrl: url, subIds: subId ? [subId] : [] } };
      const data = await shopeeQuery(appId, secret, query, variables);
      const shortLink = data?.generateShortLink?.shortLink;
      if (shortLink) return res.json({ affiliateLink: shortLink, original: url, method: 'api' });
    } catch(e) { console.warn('[convert]', e.message); }
  }
  try {
    const u = new URL(url);
    if (subId) u.searchParams.set('af_sub_siteid', subId);
    u.searchParams.set('af_channel', 'ShopeePro');
    res.json({ affiliateLink: u.toString(), original: url, method: 'manual' });
  } catch(e) {
    res.json({ affiliateLink: url, original: url, method: 'passthrough' });
  }
});

app.listen(PORT, () => console.log(`ShopeePro Backend v5.0 rodando na porta ${PORT}`));
