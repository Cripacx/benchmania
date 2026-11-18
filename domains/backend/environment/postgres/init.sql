-- 10,000 rows with deterministic content. bench_reset() restores exactly this state; the harness calls it
-- before every implementation and after every workload that writes, so nobody inherits another's updates.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
CREATE TABLE world (id integer PRIMARY KEY, randomnumber integer NOT NULL);
CREATE FUNCTION bench_reset() RETURNS void LANGUAGE sql AS $$
  TRUNCATE world;
  INSERT INTO world SELECT g, ((g * 7919) % 10000) + 1 FROM generate_series(1, 10000) AS g;
$$;
SELECT bench_reset();
ANALYZE world;
