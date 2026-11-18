use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    routing::{get, post},
};
use deadpool_postgres::{Client, Config, Pool, PoolConfig, Runtime};
use serde::{Deserialize, Serialize};
use tokio_postgres::NoTls;

const Q_ONE: &str = "SELECT id, randomnumber FROM world WHERE id = $1";
const Q_UPDATE: &str = "UPDATE world SET randomnumber = $1 WHERE id = $2";
const Q_LIST: &str = "SELECT id, randomnumber FROM world WHERE id BETWEEN $1 AND $2 ORDER BY id";

type HttpResult<T> = Result<Json<T>, (StatusCode, String)>;

fn internal<E: ToString>(e: E) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

#[derive(Serialize)]
struct Message {
    message: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct World {
    id: i32,
    random_number: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ListItem {
    id: i32,
    random_number: i32,
    is_even: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrderItem {
    sku: String,
    quantity: i64,
    unit_price: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Order {
    customer_id: i64,
    items: Vec<OrderItem>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OrderSummary {
    customer_id: i64,
    item_count: usize,
    total_quantity: i64,
    total: f64,
}

fn random_id() -> i32 {
    fastrand::i32(1..=10000)
}

async fn one(client: &Client) -> Result<World, (StatusCode, String)> {
    let stmt = client.prepare_cached(Q_ONE).await.map_err(internal)?;
    let row = client.query_one(&stmt, &[&random_id()]).await.map_err(internal)?;
    Ok(World { id: row.get(0), random_number: row.get(1) })
}

async fn json() -> Json<Message> {
    Json(Message { message: "Hello, World!" })
}

async fn db(State(pool): State<Pool>) -> HttpResult<World> {
    let client = pool.get().await.map_err(internal)?;
    Ok(Json(one(&client).await?))
}

async fn queries(State(pool): State<Pool>) -> HttpResult<Vec<World>> {
    let client = pool.get().await.map_err(internal)?;
    let mut out = Vec::with_capacity(20);
    for _ in 0..20 {
        out.push(one(&client).await?);
    }
    Ok(Json(out))
}

async fn updates(State(pool): State<Pool>) -> HttpResult<Vec<World>> {
    let client = pool.get().await.map_err(internal)?;
    let upd = client.prepare_cached(Q_UPDATE).await.map_err(internal)?;
    let mut out = Vec::with_capacity(5);
    for _ in 0..5 {
        let mut w = one(&client).await?;
        w.random_number = random_id();
        client.execute(&upd, &[&w.random_number, &w.id]).await.map_err(internal)?;
        out.push(w);
    }
    Ok(Json(out))
}

async fn list(State(pool): State<Pool>) -> HttpResult<Vec<ListItem>> {
    let client = pool.get().await.map_err(internal)?;
    let stmt = client.prepare_cached(Q_LIST).await.map_err(internal)?;
    let start: i32 = fastrand::i32(1..=9901);
    let rows = client.query(&stmt, &[&start, &(start + 99)]).await.map_err(internal)?;
    Ok(Json(
        rows.iter()
            .map(|r| {
                let rn: i32 = r.get(1);
                ListItem { id: r.get(0), random_number: rn, is_even: rn % 2 == 0 }
            })
            .collect(),
    ))
}

async fn orders(Json(o): Json<Order>) -> HttpResult<OrderSummary> {
    if o.items.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "invalid order".into()));
    }
    let (mut qty, mut total) = (0i64, 0f64);
    for it in &o.items {
        if it.quantity < 1 || it.unit_price < 0.0 || it.sku.is_empty() {
            return Err((StatusCode::BAD_REQUEST, "invalid item".into()));
        }
        qty += it.quantity;
        total += it.quantity as f64 * it.unit_price;
    }
    Ok(Json(OrderSummary {
        customer_id: o.customer_id,
        item_count: o.items.len(),
        total_quantity: qty,
        total: (total * 100.0).round() / 100.0,
    }))
}

#[tokio::main]
async fn main() {
    let mut cfg = Config::new();
    cfg.url = Some(std::env::var("DB_URL").expect("DB_URL"));
    cfg.pool = Some(PoolConfig::new(16));
    let pool = cfg.create_pool(Some(Runtime::Tokio1), NoTls).expect("pool");
    let app = Router::new()
        .route("/json", get(json))
        .route("/db", get(db))
        .route("/queries", get(queries))
        .route("/updates", get(updates))
        .route("/list", get(list))
        .route("/orders", post(orders))
        .with_state(pool);
    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
