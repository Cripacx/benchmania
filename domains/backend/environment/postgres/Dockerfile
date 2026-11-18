# PostgreSQL with the benchmark schema baked in (no bind mounts, so it also works from inside the runner).
FROM postgres:18.7-trixie
COPY init.sql /docker-entrypoint-initdb.d/init.sql
