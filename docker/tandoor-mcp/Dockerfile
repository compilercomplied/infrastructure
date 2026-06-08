FROM python:3.12-slim

# This label links the generated GHCR package directly to the main infrastructure repository's Packages UI page on GitHub.
LABEL org.opencontainers.image.source="https://github.com/compilercomplied/infrastructure"

# Git is required in the build stage to clone the third-party MCP repository from GitHub.
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Checking out a specific commit hash prevents upstream changes from silently breaking the deployment pipeline.
RUN git clone https://github.com/oculairmedia/Tandoor.mcp.git . && \
    git checkout a66940a8aae9a2c56b9a8cb1665d055909263532

# Remove the deprecated stateless_http constructor argument to prevent startup crash on recent FastMCP versions.
RUN sed -i 's/, stateless_http=True//g' server.py

# Installing dependencies at build time ensures the container is self-contained and does not download external packages at runtime.
RUN pip install --no-cache-dir -r requirements.txt

# FastMCP exposes the HTTP/SSE server on port 8000 by default.
EXPOSE 8000

# Specifying the command here makes the container executable by default, which is required since createSelfhostedApp / createMCPServer do not override container commands.
CMD ["python", "server.py"]
