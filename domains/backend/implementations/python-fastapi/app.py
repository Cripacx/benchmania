import math
import os
import random
from contextlib import asynccontextmanager

import asyncpg
from fastapi import FastAPI
from pydantic import BaseModel, Field

Q_ONE = "SELECT id, randomnumber FROM world WHERE id = $1"
Q_UPDATE = "UPDATE world SET randomnumber = $1 WHERE id = $2"
Q_LIST = "SELECT id, randomnumber FROM world WHERE id BETWEEN $1 AND $2 ORDER BY id"

pool = None


class OrderItem(BaseModel):
    sku: str = Field(min_length=1)
    quantity: int = Field(ge=1)
    unitPrice: float = Field(ge=0)


class Order(BaseModel):
    customerId: int
    items: list[OrderItem] = Field(min_length=1)


class OrderSummary(BaseModel):
    customerId: int
    itemCount: int
    totalQuantity: int
    total: float


@asynccontextmanager
async def lifespan(app):
    global pool
    pool = await asyncpg.create_pool(os.environ["DB_URL"], min_size=2, max_size=8)
    yield
    await pool.close()


app = FastAPI(lifespan=lifespan)


def random_id():
    return random.randint(1, 10000)


async def one(conn):
    row = await conn.fetchrow(Q_ONE, random_id())
    return {"id": row["id"], "randomNumber": row["randomnumber"]}


@app.get("/json")
async def json_endpoint():
    return {"message": "Hello, World!"}


@app.get("/db")
async def db():
    async with pool.acquire() as conn:
        return await one(conn)


@app.get("/queries")
async def queries():
    async with pool.acquire() as conn:
        return [await one(conn) for _ in range(20)]


@app.get("/updates")
async def updates():
    out = []
    async with pool.acquire() as conn:
        for _ in range(5):
            w = await one(conn)
            w["randomNumber"] = random_id()
            await conn.execute(Q_UPDATE, w["randomNumber"], w["id"])
            out.append(w)
    return out


@app.get("/list")
async def list_endpoint():
    start = random.randint(1, 9901)
    async with pool.acquire() as conn:
        rows = await conn.fetch(Q_LIST, start, start + 99)
    return [{"id": r["id"], "randomNumber": r["randomnumber"], "isEven": r["randomnumber"] % 2 == 0} for r in rows]


@app.post("/orders")
async def orders(o: Order) -> OrderSummary:
    qty = sum(it.quantity for it in o.items)
    cents = sum(it.quantity * it.unitPrice for it in o.items) * 100
    # Round to cents with ties away from zero (totals are non-negative), like the other stacks; round() would round
    # the exact binary value half to even.
    total = (math.floor(cents) + (cents % 1 >= 0.5)) / 100
    return OrderSummary(customerId=o.customerId, itemCount=len(o.items), totalQuantity=qty, total=total)
