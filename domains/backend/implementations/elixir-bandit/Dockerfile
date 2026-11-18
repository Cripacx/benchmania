FROM elixir:1.20.5-otp-29 AS build
ENV MIX_ENV=prod
WORKDIR /src
RUN mix local.hex --force && mix local.rebar --force
COPY mix.exs mix.lock ./
RUN mix deps.get --only prod && mix deps.compile
COPY lib lib
COPY rel rel
RUN mix release

FROM debian:trixie-20261104-slim
RUN apt-get update && apt-get install -y --no-install-recommends libssl3 libncurses6 locales ca-certificates \
 && rm -rf /var/lib/apt/lists/* && sed -i 's/# en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen
ENV LANG=en_US.UTF-8
COPY --from=build /src/_build/prod/rel/bench /app
EXPOSE 8080
CMD ["/app/bin/bench", "start"]
