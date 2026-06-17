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
const SIMPLE_QUERY = `query { productOfferV2(input: { page: 1, limit: 1 }) { nodes { itemId productName } } }`;

async function tryAuth(appId, secret, authHeader) {
  const res = await fetch(SHOPEE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
    body: JSON.stringify({ query: SIMPLE_QUERY }),
  });
  const text = await res.text();
  const ok = !text.includes('10020') && !text.includes('Invalid');
  return { ok, status: res.status, body: text.slice(0, 200) };
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', version: '5.0-diag' });
});

app.post('/shopee/diag', async (req, res) => {
  const { appId, secret } = req.body;
  if (!appId || !secret) return res.status(400).json({ error: 'appId e secret obrigatórios' });

  const ts = Math.floor(Date.now() / 1000);
  const results = [];

  const formats = [
    { name: 'F1: appId+ts (atual)', payload: `${appId}${ts}` },
    { name: 'F2: só ts', payload: `${ts}` },
    { name: 'F3: appId|ts', payload: `${appId}|${ts}` },
    { name: 'F4: appId:ts', payload: `${appId}:${ts}` },
    { name: 'F5: ts+appId', payload: `${ts}${appId}` },
  ];

  const headers = [
    (appId, ts, sign) => `SHA256 Credential=${appId}, Timestamp=${ts}, Signature=${sign}`,
    (appId, ts, sign) => `SHA256 app_id=${appId},timestamp=${ts},sign=${sign}`,
    (appId, ts, sign) => `SHA256 appid=${appId},timestamp=${ts},sign=${sign}`,
  ];

  for (const fmt of formats) {
    const sign = crypto.createHmac('sha256', secret).update(fmt.payload).digest('hex');
    for (const hdr of headers) {
      const authHeader = hdr(appId, ts, sign);
      const result = await tryAuth(appId, secret, authHeader);
      results.push({ format: fmt.name, header: authHeader.slice(0, 80), ...result });
      if (result.ok) break;
    }
    if (results.find(r => r.ok)) break;
  }

  res.json({ ts, results });
});

app.post('/shopee/ping', async (req, res) => {
  const { appId, secret } = req.body;
  res.json({ message: 'Use /shopee/diag para diagnosticar' });
});

app.listen(PORT, () => {
  console.log(`ShopeePro Backend v5.0-diag rodando na porta ${PORT}`);
});
