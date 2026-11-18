FROM python:3.15.2-trixie AS build
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

FROM python:3.15.2-slim-trixie
COPY --from=build /install /usr/local
WORKDIR /app
COPY app.py .
ENV DB_URL=postgres://bench:bench@127.0.0.1:5432/bench
EXPOSE 8080
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "2", "--no-access-log", "--log-level", "warning"]
