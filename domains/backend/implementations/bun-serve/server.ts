import { SQL } from 'bun';

// Bun has no node:cluster load balancing; run N processes sharing the port via reusePort.
const WORKERS = Number(process.env.WORKERS ?? 2);

interface OrderItem { sku: string; quantity: number; unitPrice: number }
interface Order { customerId: number; items: OrderItem[] }

const randomId = (): number => 1 + Math.floor(Math.random() * 10000);

if (!process.env.BUN_CHILD) {
  for (let i = 0; i < WORKERS; i++) {
    Bun.spawn(['bun', import.meta.path], { env: { ...process.env, BUN_CHILD: '1' }, stdout: 'inherit', stderr: 'inherit' });
  }
} else {
  const sql = new SQL({ url: process.env.DB_URL, max: 8 });
  const one = async (db: SQL) => {
    const [row] = await db`SELECT id, randomnumber FROM world WHERE id = ${randomId()}`;
    return { id: row.id, randomNumber: row.randomnumber };
  };
  Bun.serve({
    port: 8080,
    hostname: '0.0.0.0',
    reusePort: true,
    routes: {
      '/json': () => Response.json({ message: 'Hello, World!' }),
      '/db': async () => Response.json(await one(sql)),
      '/queries': async () => {
        const db = await sql.reserve();
        try {
          const out = [];
          for (let i = 0; i < 20; i++) out.push(await one(db));
          return Response.json(out);
        } finally { db.release(); }
      },
      '/updates': async () => {
        const db = await sql.reserve();
        try {
          const out = [];
          for (let i = 0; i < 5; i++) {
            const w = await one(db);
            w.randomNumber = randomId();
            await db`UPDATE world SET randomnumber = ${w.randomNumber} WHERE id = ${w.id}`;
            out.push(w);
          }
          return Response.json(out);
        } finally { db.release(); }
      },
      '/list': async () => {
        const start = 1 + Math.floor(Math.random() * 9901);
        const rows = await sql`SELECT id, randomnumber FROM world WHERE id BETWEEN ${start} AND ${start + 99} ORDER BY id`;
        return Response.json(rows.map((r: { id: number; randomnumber: number }) => ({ id: r.id, randomNumber: r.randomnumber, isEven: r.randomnumber % 2 === 0 })));
      },
      '/orders': {
        POST: async (req) => {
          let o: Order;
          try { o = await req.json() as Order; } catch { return new Response(null, { status: 400 }); }
          if (!o || !Array.isArray(o.items) || o.items.length === 0) return new Response(null, { status: 400 });
          let qty = 0;
          let total = 0;
          for (const it of o.items) {
            if (!(it.quantity >= 1) || !(it.unitPrice >= 0) || !it.sku) return new Response(null, { status: 400 });
            qty += it.quantity;
            total += it.quantity * it.unitPrice;
          }
          return Response.json({ customerId: o.customerId, itemCount: o.items.length, totalQuantity: qty, total: Math.round(total * 100) / 100 });
        },
      },
    },
    fetch: () => new Response('not found', { status: 404 }),
  });
}
