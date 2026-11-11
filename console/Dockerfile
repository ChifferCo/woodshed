# syntax=docker/dockerfile:1.7
#
# Woodshed console image, run on the base box behind Caddy. Build from
# the repo root:
#
#   docker build -f woodshed/console/Dockerfile -t woodshed-console .
#
# It needs the `gh` and `aws` CLIs, and for My settings' Restore a dump (dbRestore.mjs) Postgres 16's pg_restore and
# psql (16, as RDS is) and Mongo's mongorestore and mongosh, and nothing from npm. Only this folder and
# Woodshed's same-origin checks come from the context (Dockerfile.dockerignore).

FROM node:22.16.0-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl unzip \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/keyrings/pgdg.asc \
  && echo "deb [signed-by=/usr/share/keyrings/pgdg.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
  && curl -fsSL https://pgp.mongodb.com/server-8.0.asc -o /usr/share/keyrings/mongodb.asc \
  && echo "deb [signed-by=/usr/share/keyrings/mongodb.asc] https://repo.mongodb.org/apt/debian bookworm/mongodb-org/8.0 main" > /etc/apt/sources.list.d/mongodb.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh postgresql-client-16 mongodb-database-tools mongodb-mongosh \
  && curl -fsSL -o /tmp/awscliv2.zip https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip \
  && unzip -q /tmp/awscliv2.zip -d /tmp \
  && /tmp/aws/install \
  && rm -rf /tmp/aws /tmp/awscliv2.zip /var/lib/apt/lists/* \
  && mkdir -p /var/lib/woodshed-cloud && chown node:node /var/lib/woodshed-cloud

# Copied under the repo's own layout so the relative imports of woodshed/shared/ (sameOrigin.mjs, pwa.mjs) resolve.
# woodshed/shared/ goes whole, as in the session image; its tests, fixtures and Markdown stay out.
COPY --chown=node:node woodshed/console/ /opt/woodshed/console/
COPY --chown=node:node woodshed/shared/ /opt/woodshed/shared/
# The providers' code (not their Terraform): providers/console.mjs picks one and starts the console on it.
COPY --chown=node:node woodshed/providers/ /opt/woodshed/providers/
# Each person's ~/.tmux.conf on My settings starts as a copy of the session image's.
COPY --chown=node:node woodshed/session/tmux.conf /opt/woodshed/session/tmux.conf

USER node
EXPOSE 7690
CMD ["node", "/opt/woodshed/providers/console.mjs"]
