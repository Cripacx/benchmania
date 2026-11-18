using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Http.HttpResults;
using Npgsql;

const string QOne = "SELECT id, randomnumber FROM world WHERE id = $1";
const string QUpdate = "UPDATE world SET randomnumber = $1 WHERE id = $2";
const string QList = "SELECT id, randomnumber FROM world WHERE id BETWEEN $1 AND $2 ORDER BY id";

var builder = WebApplication.CreateSlimBuilder(args);
builder.Logging.ClearProviders();
builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.TypeInfoResolverChain.Insert(0, AppJsonContext.Default));
var ds = new NpgsqlSlimDataSourceBuilder(Environment.GetEnvironmentVariable("DB_URL")).Build();
var app = builder.Build();

static int RandomId() => Random.Shared.Next(1, 10001);

static async Task<World> One(NpgsqlConnection conn)
{
    await using var cmd = new NpgsqlCommand(QOne, conn);
    cmd.Parameters.Add(new NpgsqlParameter<int> { TypedValue = RandomId() });
    await using var r = await cmd.ExecuteReaderAsync();
    await r.ReadAsync();
    return new World(r.GetInt32(0), r.GetInt32(1));
}

app.MapGet("/json", () => new Message("Hello, World!"));

app.MapGet("/db", async () =>
{
    await using var conn = await ds.OpenConnectionAsync();
    return await One(conn);
});

app.MapGet("/queries", async () =>
{
    await using var conn = await ds.OpenConnectionAsync();
    var result = new World[20];
    for (var i = 0; i < result.Length; i++) result[i] = await One(conn);
    return result;
});

app.MapGet("/updates", async () =>
{
    await using var conn = await ds.OpenConnectionAsync();
    var result = new World[5];
    for (var i = 0; i < result.Length; i++)
    {
        var w = await One(conn) with { randomNumber = RandomId() };
        await using var cmd = new NpgsqlCommand(QUpdate, conn);
        cmd.Parameters.Add(new NpgsqlParameter<int> { TypedValue = w.randomNumber });
        cmd.Parameters.Add(new NpgsqlParameter<int> { TypedValue = w.id });
        await cmd.ExecuteNonQueryAsync();
        result[i] = w;
    }
    return result;
});

app.MapGet("/list", async () =>
{
    await using var conn = await ds.OpenConnectionAsync();
    var start = Random.Shared.Next(1, 9902);
    await using var cmd = new NpgsqlCommand(QList, conn);
    cmd.Parameters.Add(new NpgsqlParameter<int> { TypedValue = start });
    cmd.Parameters.Add(new NpgsqlParameter<int> { TypedValue = start + 99 });
    await using var r = await cmd.ExecuteReaderAsync();
    var items = new List<ListItem>(100);
    while (await r.ReadAsync())
    {
        var rn = r.GetInt32(1);
        items.Add(new ListItem(r.GetInt32(0), rn, rn % 2 == 0));
    }
    return items;
});

app.MapPost("/orders", Results<Ok<OrderSummary>, BadRequest> (Order o) =>
{
    if (o.items is not { Count: > 0 }) return TypedResults.BadRequest();
    int qty = 0;
    double total = 0;
    foreach (var it in o.items)
    {
        if (it.quantity < 1 || it.unitPrice < 0 || string.IsNullOrEmpty(it.sku)) return TypedResults.BadRequest();
        qty += it.quantity;
        total += it.quantity * it.unitPrice;
    }
    return TypedResults.Ok(new OrderSummary(o.customerId, o.items.Count, qty, Math.Round(total * 100, MidpointRounding.AwayFromZero) / 100));
});

app.Run("http://0.0.0.0:8080");

record Message(string message);
record World(int id, int randomNumber);
record ListItem(int id, int randomNumber, bool isEven);
record OrderItem(string sku, int quantity, double unitPrice);
record Order(int customerId, List<OrderItem> items);
record OrderSummary(int customerId, int itemCount, int totalQuantity, double total);

[JsonSerializable(typeof(Message))]
[JsonSerializable(typeof(World))]
[JsonSerializable(typeof(World[]))]
[JsonSerializable(typeof(List<ListItem>))]
[JsonSerializable(typeof(Order))]
[JsonSerializable(typeof(OrderSummary))]
partial class AppJsonContext : JsonSerializerContext { }
