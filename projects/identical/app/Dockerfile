# Standard library only, so there is nothing to install and nothing to pin.
FROM python:3.11-slim

# Unbuffered so logs reach the host as they happen rather than on exit.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8080 \
    IDENTICAL_DB=/data/identical.db

WORKDIR /srv
COPY app ./app

# Runs as a non-root user, which needs the volume to be writable by it.
RUN useradd --create-home --uid 10001 identical \
    && mkdir -p /data \
    && chown -R identical:identical /srv /data
USER identical

EXPOSE 8080

# The health check the platform polls; also catches a container that started
# but cannot answer, which a process check would miss.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request,os;urllib.request.urlopen(f'http://127.0.0.1:{os.environ[\"PORT\"]}/healthz',timeout=4)"

CMD ["python", "-m", "app"]
