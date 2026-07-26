FROM python:3.12-slim-bookworm
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY run.py .
COPY docker/entrypoint.sh /app/docker/entrypoint.sh
RUN chmod +x /app/docker/entrypoint.sh

ENV PYTHONUNBUFFERED=1 \
    DATA_DIR=/data \
    SQLITE_PATH=/data/historia.db

EXPOSE 8000
ENTRYPOINT ["/app/docker/entrypoint.sh"]
