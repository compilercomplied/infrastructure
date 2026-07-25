FROM ubuntu:22.04

# Avoid prompt dialogs during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Install Node.js (v20), git, curl, and the Docker CLI from official Ubuntu/NodeSource repos
RUN apt-get update && apt-get install -y \
    curl \
    git \
    sudo \
    ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs docker.io docker-buildx \
    && rm -rf /var/lib/apt/lists/*
