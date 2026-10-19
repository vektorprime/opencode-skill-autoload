---
name: docker-compose
description: Use when building, running or debugging Docker images, containers and docker compose stacks.
---

# Docker and docker compose

## Building images

Write a small Dockerfile: pin the base image tag, copy dependency manifests before the source so
layer caching works, and run as a non-root user. Build with `docker build -t name:tag .` and check
the image size with `docker image ls`.

## Running a compose stack

Start everything with `docker compose up -d` and follow output with `docker compose logs -f <service>`.
Rebuild a changed service with `docker compose up -d --build <service>`. Stop and remove containers
with `docker compose down`; add `-v` only if the volumes should be deleted too.

## Debugging containers that exit

If a container exits immediately, read its logs with `docker logs <container>` and check the exit
code with `docker inspect`. Open a shell in a running container with `docker exec -it <container> sh`.
Override the entrypoint to keep a broken container alive while you investigate.

## Networking and ports

Services in the same compose file reach each other by service name. Publish ports with
`ports: ["8080:80"]`. A connection refused error from the host usually means the app listens on
127.0.0.1 inside the container instead of 0.0.0.0.

## Volumes and data

Use named volumes for databases so data survives `docker compose down`. Bind-mount source code
during development only.
