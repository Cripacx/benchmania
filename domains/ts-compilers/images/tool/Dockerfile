# One compiler on top of the workloads image (built by the harness, so every tool image shares its layers).
# The harness passes PACKAGE ([compiler] package of impl.toml) and VERSION (its entry in [versions]).
ARG WORKLOADS
FROM ${WORKLOADS}
ARG PACKAGE
ARG VERSION
RUN mkdir -p /opt/tool && cd /opt/tool && echo '{"private":true}' > package.json \
 && npm install --no-audit --no-fund --save-exact "${PACKAGE}@${VERSION}" \
 && test "$(node -p "require('/opt/tool/node_modules/${PACKAGE}/package.json').version")" = "${VERSION}"
ENV PATH=/opt/tool/node_modules/.bin:$PATH
COPY timer.py /bench/timer.py
