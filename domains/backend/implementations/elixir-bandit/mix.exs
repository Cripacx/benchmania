defmodule Bench.MixProject do
  use Mix.Project

  def project do
    [app: :bench, version: "0.1.0", elixir: "~> 1.20", start_permanent: true, deps: deps()]
  end

  def application do
    [extra_applications: [:logger], mod: {Bench.Application, []}]
  end

  defp deps do
    [
      {:bandit, "1.15.0"},
      {:plug, "1.20.4"},
      {:postgrex, "0.22.4"},
      {:jason, "1.4.5"}
    ]
  end
end
