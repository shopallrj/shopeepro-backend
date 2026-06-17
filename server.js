const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.options('*', cors());
app.use(express.json());

// ── Shopee API GraphQL ────────────────────────────────────────────
const SHOPEE_API = 'https://open-api.affiliate.shopee.com.br/graphql';

function buildShopeeHeaders(appId, secret) {
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = `${appId}${timestamp}`;
  const sign = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return {
    'Content-Type': 'application/json',
    'Authorization': `SHA256 app_id=${appId},timestamp=${timestamp},sign=${sign}`,
  };
}

async function shopeeQuery(appId, secret, query, variables = {}) {
  const res = await fetch(SHOPEE_API, {
    method: 'POST',
    headers: buildShopeeHeaders(appId, secret),
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Shopee API erro ${res.status}`);
  const data = await res.json();
  if (data.errors) throw new Error(data.errors[0]?.message || 'Shopee API error');
  return data.data;
}

// ── Rota de teste ─────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'ShopeePro Backend v3 rodando!', version: '3.0' });
});

// ── ROTA: Buscar produtos ─────────────────────────────────────────
app.post('/shopee/search', async (req, res) => {
  const { appId, secret, subId = '', keyword = '', category, minComm = 0, extraOnly = false } = req.body;
  if (!appId || !secret) return res.status(400).json({ error: 'appId e secret são obrigatórios' });

  try {
    const query = `
      query getOfferList($input: OfferListInput!) {
        getOfferList(input: $input) {
          nodes {
            itemId
            shopId
            name
            image
            price
            priceMin
            priceMax
            priceBefore
            ratingStar
            sales
            commissionRate
            sellerCommissionRate
            shopName
            shopType
            url
            affiliateUrl
          }
          pageInfo { hasNextPage }
        }
      }
    `;

    const variables = {
      input: {
        page: 1,
        limit: 30,
        keyword: keyword || undefined,
        sortType: minComm > 0 ? 2 : 1, // 1=relevance, 2=commission
        subId: subId || undefined,
        extraCommissionOnly: extraOnly || undefined,
      },
    };

    const data = await shopeeQuery(appId, secret, query, variables);
    const items = data?.getOfferList?.nodes || [];

    const products = items
      .filter(p => {
        const comm = (p.commissionRate || 0) + (p.sellerCommissionRate || 0);
        return comm >= minComm;
      })
      .map(p => {
        const price = p.price || p.priceMin || 0;
        const originalPrice = p.priceBefore || null;
        const discount = originalPrice && price ? Math.round((1 - price / originalPrice) * 100) : 0;
        const commRate = (p.commissionRate || 0);
        const sellerComm = (p.sellerCommissionRate || 0);

        return {
          id: `${p.shopId}-${p.itemId}`,
          title: p.name,
          price,
          originalPrice,
          discount,
          image: p.image,
          shop: p.shopName,
          rating: p.ratingStar,
          sales: p.sales,
          commissionRate: commRate,
          sellerComm,
          totalComm: commRate + sellerComm,
          link: p.url,
          affiliateLink: p.affiliateUrl || p.url,
        };
      });

    res.json({ products, total: products.length });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ROTA: Promoções relâmpago ─────────────────────────────────────
app.post('/shopee/flash', async (req, res) => {
  const { appId, secret, subId = '', minComm = 0 } = req.body;
  if (!appId || !secret) return res.status(400).json({ error: 'appId e secret são obrigatórios' });

  try {
    const query = `
      query getOfferList($input: OfferListInput!) {
        getOfferList(input: $input) {
          nodes {
            itemId
            shopId
            name
            image
            price
            priceMin
            priceBefore
            commissionRate
            sellerCommissionRate
            shopName
            url
            affiliateUrl
            priceDiscountRate
          }
          pageInfo { hasNextPage }
        }
      }
    `;

    const variables = {
      input: {
        page: 1,
        limit: 20,
        sortType: 2, // maior comissão
        subId: subId || undefined,
      },
    };

    const data = await shopeeQuery(appId, secret, query, variables);
    const items = data?.getOfferList?.nodes || [];

    const products = items
      .filter(p => (p.commissionRate || 0) + (p.sellerCommissionRate || 0) >= minComm)
      .map(p => {
        const price = p.price || p.priceMin || 0;
        const originalPrice = p.priceBefore || null;
        const discount = p.priceDiscountRate
          ? Math.round(p.priceDiscountRate * 100)
          : (originalPrice && price ? Math.round((1 - price / originalPrice) * 100) : 0);

        return {
          id: `${p.shopId}-${p.itemId}`,
          title: p.name,
          price,
          originalPrice,
          discount,
          image: p.image,
          shop: p.shopName,
          commissionRate: p.commissionRate || 0,
          sellerComm: p.sellerCommissionRate || 0,
          link: p.url,
          affiliateLink: p.affiliateUrl || p.url,
          isFlash: true,
        };
      });

    res.json({ products, total: products.length });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ROTA: Converter link ──────────────────────────────────────────
app.post('/shopee/convert', async (req, res) => {
  const { url, subId = '', appId, secret } = req.body;
  if (!url) return res.status(400).json({ error: 'URL obrigatória' });

  if (appId && secret) {
    try {
      const query = `
        mutation generateAffiliateLink($input: GenerateAffiliateLinkInput!) {
          generateAffiliateLink(input: $input) {
            affiliate_link
          }
        }
      `;
      const variables = { input: { original_url: url, sub_ids: subId ? [subId] : [] } };
      const data = await shopeeQuery(appId, secret, query, variables);
      const affiliateLink = data?.generateAffiliateLink?.affiliate_link;
      if (affiliateLink) return res.json({ affiliateLink, original: url, method: 'api' });
    } catch(e) {
      console.warn('[Shopee API convert]', e.message);
    }
  }

  // Fallback manual
  try {
    const u = new URL(url);
    if (subId) u.searchParams.set('af_sub_siteid', subId);
    u.searchParams.set('af_channel', 'ShopeePro');
    res.json({ affiliateLink: u.toString(), original: url, method: 'manual' });
  } catch(e) {
    res.json({ affiliateLink: url, original: url, method: 'passthrough' });
  }
});

app.listen(PORT, () => {
  console.log(`ShopeePro Backend v3 rodando na porta ${PORT}`);
});
