FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PORT=8000 TRUST_PROXY=1
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY app ./app
COPY static ./static
COPY data ./data
RUN useradd -m app && chown -R app /app
USER app
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import os,urllib.request as u;u.urlopen('http://localhost:%s/api/health'%os.environ['PORT'])"
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --proxy-headers"]
