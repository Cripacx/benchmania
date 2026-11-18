import cluster from 'node:cluster';
import Fastify from 'fastify';
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
  const app = Fastify({ logger: false });

  app.get('/json', async () => ({ message: 'Hello, World!' }));
  app.get('/db', async () => one(pool));
  app.get('/queries', async () => {
    const client = await pool.connect();
    try {
      const out = [];
      for (let i = 0; i < 20; i++) out.push(await one(client));
      return out;
    } finally { client.release(); }
  });
  app.get('/updates', async () => {
    const client = await pool.connect();
    try {
      const out = [];
      for (let i = 0; i < 5; i++) {
        const w = await one(client);
        w.randomNumber = randomId();
        await client.query({ name: 'upd', text: Q_UPDATE, values: [w.randomNumber, w.id] });
        out.push(w);
      }
      return out;
    } finally { client.release(); }
  });
  app.get('/list', async () => {
    const start = 1 + Math.floor(Math.random() * 9901);
    const { rows } = await pool.query({ name: 'list', text: Q_LIST, values: [start, start + 99] });
    return rows.map((r) => ({ id: r.id, randomNumber: r.randomnumber, isEven: r.randomnumber % 2 === 0 }));
  });
  app.post('/orders', async (req, reply) => {
    const o = req.body as Order;
    if (!o || !Array.isArray(o.items) || o.items.length === 0) return reply.code(400).send();
    let qty = 0;
    let total = 0;
    for (const it of o.items) {
      if (!(it.quantity >= 1) || !(it.unitPrice >= 0) || !it.sku) return reply.code(400).send();
      qty += it.quantity;
      total += it.quantity * it.unitPrice;
    }
    return { customerId: o.customerId, itemCount: o.items.length, totalQuantity: qty, total: Math.round(total * 100) / 100 };
  });
  await app.listen({ port: 8080, host: '0.0.0.0' });
}
