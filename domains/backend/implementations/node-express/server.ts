import cluster from 'node:cluster';
import express from 'express';
import pg from 'pg';

const WORKERS = Number(process.env.WORKERS ?? 2);
const Q_ONE = 'SELECT id, randomnumber FROM world WHERE id = $1';
const Q_UPDATE = 'UPDATE world SET randomnumber = $1 WHERE id = $2';
const Q_LIST = 'SELECT id, randomnumber FROM world WHERE id BETWEEN $1 AND $2 ORDER BY id';

interface OrderItem { sku: string; quantity: number; unitPrice: number }
interface Order { customerId: number; items: OrderItem[] }

const randomId = (): number => 1 + Math.floor(Math.random() * 10000);

if (cluster.isPrimary) {
  for (let i = 0; i < WORKERS; i++) cluster.fork();
} else {
  const pool = new pg.Pool({ connectionString: process.env.DB_URL, max: 8 });
  const one = async (client: pg.Pool | pg.PoolClient) => {
    const { rows } = await client.query({ name: 'one', text: Q_ONE, values: [randomId()] });
    return { id: rows[0].id, randomNumber: rows[0].randomnumber };
  };
  const app = express();
  app.disable('x-powered-by');

  app.get('/json', (_req, res) => { res.json({ message: 'Hello, World!' }); });
  app.get('/db', async (_req, res) => { res.json(await one(pool)); });
  app.get('/queries', async (_req, res) => {
    const client = await pool.connect();
    try {
      const out = [];
      for (let i = 0; i < 20; i++) out.push(await one(client));
      res.json(out);
    } finally { client.release(); }
  });
  app.get('/updates', async (_req, res) => {
    const client = await pool.connect();
    try {
      const out = [];
      for (let i = 0; i < 5; i++) {
        const w = await one(client);
        w.randomNumber = randomId();
        await client.query({ name: 'upd', text: Q_UPDATE, values: [w.randomNumber, w.id] });
        out.push(w);
      }
      res.json(out);
    } finally { client.release(); }
  });
  app.get('/list', async (_req, res) => {
    const start = 1 + Math.floor(Math.random() * 9901);
    const { rows } = await pool.query({ name: 'list', text: Q_LIST, values: [start, start + 99] });
    res.json(rows.map((r) => ({ id: r.id, randomNumber: r.randomnumber, isEven: r.randomnumber % 2 === 0 })));
  });
  app.post('/orders', express.json(), (req, res) => {
    const o = req.body as Order;
    if (!o || !Array.isArray(o.items) || o.items.length === 0) { res.status(400).end(); return; }
    let qty = 0;
    let total = 0;
    for (const it of o.items) {
      if (!(it.quantity >= 1) || !(it.unitPrice >= 0) || !it.sku) { res.status(400).end(); return; }
      qty += it.quantity;
      total += it.quantity * it.unitPrice;
    }
    res.json({ customerId: o.customerId, itemCount: o.items.length, totalQuantity: qty, total: Math.round(total * 100) / 100 });
  });
  app.listen(8080, '0.0.0.0');
}
