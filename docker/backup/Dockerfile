# The backup service and the tool restore.sh drives: pg_dump and pg_restore of the
# console database, restic for the encrypted repositories, psql for the checks.
#
# restic comes from the project's own image, a single static binary, so its version is
# the one pinned here and not whatever the distribution packages that week. The
# PostgreSQL client is the major version of the server in docker-compose.yml
# (postgres:18): pg_dump refuses a server newer than itself, and a client older than
# the server cannot restore what a newer one wrote.
FROM docker.io/restic/restic:0.19.1 AS restic

FROM docker.io/library/alpine:3.24.2

# jq reads restic's JSON, openssh-client is what restic's sftp backend runs.
RUN apk add --no-cache postgresql18 postgresql18-client postgresql18-contrib jq openssh-client-default \
 && adduser -D -u 10001 neronet

COPY --from=restic /usr/bin/restic /usr/bin/restic

COPY neronet-backup.sh /usr/local/bin/neronet-backup
COPY digest-key.sql digest-all.sql /usr/local/share/neronet-backup/

# Created in the image, owned by the unprivileged user: an empty named volume mounted
# over a path that exists in the image takes the image's ownership, and one mounted
# over a path that does not comes up owned by root, where uid 10001 cannot write.
#   /repo, /secondary   the two repositories when they are local paths
#   /cache              restic's cache, which makes a remote repository usable
#   /source/backend_data  the backend's data volume; 10001 is the uid the backend runs as,
#                         which is what lets this service read the key files (mode 0600)
RUN chmod 0755 /usr/local/bin/neronet-backup \
 && mkdir -p /repo /secondary /cache /work /source/backend_data /home/neronet/.ssh \
 && chown -R 10001:10001 /repo /secondary /cache /work /source /home/neronet \
 && chmod 700 /home/neronet/.ssh

ENV RESTIC_CACHE_DIR=/cache
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/neronet-backup"]
CMD ["run"]
