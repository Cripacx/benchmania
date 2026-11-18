defmodule Bench.Application do
  use Application

  def start(_type, _args) do
    children = [
      # queue_target/queue_interval raised so that checkouts wait for a free connection, as in the other stacks,
      # instead of being dropped by DBConnection's defaults (50 ms / 1 s) whenever requests queue for the pool.
      {Postgrex,
       name: :db, hostname: "127.0.0.1", username: "bench", password: "bench", database: "bench", pool_size: 16,
       queue_target: 5_000, queue_interval: 10_000},
      {Bandit, plug: Bench.Router, port: 8080, ip: {0, 0, 0, 0}}
    ]

    Supervisor.start_link(children, strategy: :one_for_one, name: Bench.Supervisor)
  end
end

defmodule Bench.DB do
  @queries %{
    one: "SELECT id, randomnumber FROM world WHERE id = $1",
    update: "UPDATE world SET randomnumber = $1 WHERE id = $2",
    list: "SELECT id, randomnumber FROM world WHERE id BETWEEN $1 AND $2 ORDER BY id"
  }

  # Prepared once and reused, as Ecto does by default; Postgrex re-prepares per connection as needed.
  # The first use prepares on the connection the caller already has: checking a second one out of the pool
  # while holding one deadlocks the pool as soon as 16 requests do it at the same time.
  defp query(conn, name) do
    key = {__MODULE__, name}

    case :persistent_term.get(key, nil) do
      nil ->
        q = Postgrex.prepare!(conn, Atom.to_string(name), @queries[name])
        :persistent_term.put(key, q)
        q

      q ->
        q
    end
  end

  def execute(conn, name, params), do: Postgrex.execute!(conn, query(conn, name), params)

  def random_id, do: :rand.uniform(10000)

  def one(conn) do
    %{rows: [[id, rn]]} = execute(conn, :one, [random_id()])
    %{id: id, randomNumber: rn}
  end
end

defmodule Bench.Router do
  use Plug.Router
  alias Bench.DB

  plug :match
  plug Plug.Parsers, parsers: [:json], json_decoder: Jason, pass: ["*/*"]
  plug :dispatch

  defp json(conn, status, body) do
    conn |> put_resp_content_type("application/json") |> send_resp(status, Jason.encode!(body))
  end

  get "/json" do
    json(conn, 200, %{message: "Hello, World!"})
  end

  get "/db" do
    json(conn, 200, DB.one(:db))
  end

  get "/queries" do
    out = DBConnection.run(:db, fn c -> for _ <- 1..20, do: DB.one(c) end)
    json(conn, 200, out)
  end

  get "/updates" do
    out =
      DBConnection.run(:db, fn c ->
        for _ <- 1..5 do
          w = %{DB.one(c) | randomNumber: DB.random_id()}
          DB.execute(c, :update, [w.randomNumber, w.id])
          w
        end
      end)

    json(conn, 200, out)
  end

  get "/list" do
    start = :rand.uniform(9901)
    %{rows: rows} = DB.execute(:db, :list, [start, start + 99])
    json(conn, 200, for([id, rn] <- rows, do: %{id: id, randomNumber: rn, isEven: rem(rn, 2) == 0}))
  end

  post "/orders" do
    with %{"customerId" => cid, "items" => [_ | _] = items} <- conn.body_params,
         true <- Enum.all?(items, &valid_item?/1) do
      {qty, total} =
        Enum.reduce(items, {0, 0.0}, fn it, {q, t} ->
          {q + it["quantity"], t + it["quantity"] * it["unitPrice"]}
        end)

      json(conn, 200, %{customerId: cid, itemCount: length(items), totalQuantity: qty, total: round(total * 100) / 100})
    else
      _ -> send_resp(conn, 400, "")
    end
  end

  match _ do
    send_resp(conn, 404, "")
  end

  defp valid_item?(%{"sku" => sku, "quantity" => q, "unitPrice" => p})
       when is_binary(sku) and sku != "" and is_integer(q) and q >= 1 and is_number(p) and p >= 0,
       do: true

  defp valid_item?(_), do: false
end
